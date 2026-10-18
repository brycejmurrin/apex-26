/**
 * SceneryApi: the `api` object every circuit scenery closure receives,
 * `window.TrackScenery[id](api)` in f1-game js/circuits/scenery/*.js (52 files).
 *
 * Built by f1-game js/track/scenery/build-props.js:1997-2053 (the literal,
 * then `TrackModels.drapeKit` adds `drape`/`drapeRun`). The member set is the
 * 114 names frozen by f1-game tests/unit/scenery-api-contract.test.mjs:25-48
 * (`CONTRACT_SIZE = 114`); tests/unit/contracts.test.ts re-asserts the same
 * list against `keyof SceneryApi`. Signatures come from each implementation
 * (cited per member) and docs/SCENERY-API.md.
 *
 * Conventions (docs/SCENERY-API.md §Positioning model):
 * - `k` is a node index 0..n-1 (`K(frac)` maps a lap fraction to it).
 * - `side` is -1 left / +1 right of the racing direction.
 * - `dist` is metres beyond the road edge (prop centre); `gap` is clearance,
 *   the inner face's distance beyond the edge.
 * - `s`, `s0`, `s1` on range helpers are LAP FRACTIONS 0..1, not metres.
 *
 * Option bags whose keys f1-game documents but this contract has not yet
 * typed from their implementations are `SceneryOpts` (an open record).
 * TODO(Phase 3 scenery codemod): tighten each `SceneryOpts` from its emitter.
 */
import type { Vec3 } from "./track";

/** A read-only 3-vector (colour RGB 0..1, or a world point/direction). */
export type RVec3 = readonly [number, number, number];

/** An oriented basis `[right, up, forward]`. f1-game geom.js:112 "basis optional [right,up,fwd]". */
export type Basis = readonly [RVec3, RVec3, RVec3];

/**
 * An open option bag. TODO(Phase 3): replace each use with an interface typed
 * from that emitter's implementation; the doc comment on each member lists the
 * keys docs/SCENERY-API.md names.
 */
export type SceneryOpts = { readonly [key: string]: unknown };

/** One growable typed-array accumulator. f1-game js/track/scenery/models.js `makeAccum` (:22-40). */
export interface Accum {
  readonly length: number;
  push(...values: number[]): void;
}

/**
 * The mesh accumulator `out` (and every `stage` buffer). f1-game
 * models.js:52-64 `scratch()`: Float64 pos/nrm/col/mat, Uint32 idx. Circuits
 * set `out._mat = MAT.X` before emitting (353 writes across the 52 files) and
 * reset it to 0 after.
 */
export interface SceneryBuffer {
  readonly pos: Accum;
  readonly nrm: Accum;
  readonly col: Accum;
  readonly mat: Accum | null;
  readonly idx: Accum;
  /** Material id stamped on the next emitted vertices (`MAT` value). */
  _mat: number;
}

/**
 * The built track as scenery reads it. f1-game js/track/tracks.js:76-79,157:
 * per-node Float32Array columns. Circuits read `total`, `rx/ry/rz`, `tx/ty/tz`
 * and `_night` directly, and pass `track` to `upOf`.
 */
export interface SceneryTrack {
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
}

/**
 * Circuit palette colours (`def.palette`, build-props.js:241). Mutable on
 * purpose: circuits do `Object.assign(pal, ATM.coolNight)`, which also writes
 * the pack's `fogDensity` number.
 */
export type SceneryPalette = { [key: string]: RVec3 | number };

/**
 * The circuit def fields scenery closures read (grep `def\.` over the 52
 * files). TODO(T1.1): replace with `CircuitDef` from src/circuits/types.ts,
 * which must stay assignable to this.
 */
export interface SceneryDef {
  readonly id: string;
  readonly palette: SceneryPalette;
  readonly theme?: string;
  readonly _sceneryShift?: number;
  readonly startFrac?: number;
  readonly sceneryStartFrac?: number;
  readonly reverse?: boolean;
  readonly street?: boolean;
  readonly lengthKm?: number;
  readonly barrierGap?: number;
  readonly standSet?: readonly string[];
  /** TODO(T1.1): CircuitDef `turns` shape. */
  readonly turns?: unknown;
  /** TODO(T1.1): CircuitDef `pit` shape. */
  readonly pit?: unknown;
  /** TODO(T1.1): CircuitDef `furniture` shape. */
  readonly furniture?: unknown;
}

/** Material ids; the texture-array layer index IS the id. f1-game js/track/core/geom.js:7-17. */
export type MatName =
  | "FLAT" | "CONCRETE" | "BRICK" | "GLASS" | "METAL" | "WOOD" | "FOLIAGE" | "FABRIC"
  | "SAND" | "GRASS" | "ROCK" | "SNOW" | "ROOF" | "STONE" | "RUST" | "FLAG" | "ASPHALT";

/** An atmosphere pack. f1-game js/track/scenery/data.js:135-172 (`ATM`). */
export interface AtmPack {
  readonly zenith: RVec3;
  readonly horizon: RVec3;
  readonly fog: RVec3;
  readonly fogDensity: number;
  readonly ambientSky: RVec3;
  readonly ambientGround: RVec3;
  readonly sunColor: RVec3;
  readonly grass: RVec3;
  readonly runoff: RVec3;
}
export type AtmPackName =
  | "coolNight" | "warmNight" | "dampArdennes" | "britishOvercast" | "dustyBowl" | "alpineGreen" | "rivieraDay";

/** `anchor()` result: a ground point plus the track basis at the resolved node. nature.js:92-130. */
export interface SceneryAnchor {
  readonly c: Vec3;
  readonly r: Vec3;
  readonly u: Vec3;
  readonly t: Vec3;
  /** The RESOLVED node (remapped on shifted/reversed circuits). */
  readonly k: number;
}

/** `frameAt()` result: centreline frame at a lap fraction. build-props.js:623-632. */
export interface SceneryFrame {
  readonly k: number;
  readonly c: Vec3;
  readonly r: Vec3;
  readonly u: Vec3;
  readonly t: Vec3;
  readonly hw: number;
}

/** `place()`/`prop()` result: what a fitting mounted on the box needs. build-props.js:1214. */
export interface PlaceResult {
  readonly top: Vec3;
  readonly basis: [Vec3, Vec3, Vec3];
}

/** `lapBounds()`: lap XZ centroid and farthest-node radius, frozen. build-props.js:1988-1996. */
export interface LapBounds {
  readonly cx: number;
  readonly cz: number;
  readonly radius: number;
}

/** `bakedModel` options. build-props.js:1778 and docs/SCENERY-API.md §Baked models. */
export interface BakedModelOpts {
  readonly scale?: number;
  readonly rotY?: number;
  readonly lift?: number;
  readonly tint?: RVec3;
  readonly mat?: number;
}

/** `drape` options. models.js:691-696 (`cell`, `res`, `widen`, `phase`) and docs (`h`, `line`). */
export interface DrapeOpts {
  readonly h?: number;
  readonly res?: number;
  readonly line?: boolean;
  readonly phase?: number;
  readonly cell?: number;
  readonly widen?: number;
}

/** `foundation` spec. build-props.js:739-760. `size` is `[width, depth]` (2 values). */
export interface FoundationSpec {
  readonly center: RVec3;
  readonly size: readonly [number, number];
  readonly top: number;
  readonly basis?: Basis;
  readonly ground?: number;
  readonly embed?: number;
  readonly col?: RVec3;
}

/** `modelGroup` bounds. models.js:213-220 (`center`, `size` validated; whole object goes to preflight). */
export interface ModelBounds {
  readonly center: RVec3;
  readonly size: RVec3;
  readonly basis?: Basis;
}

/** `modelGroup` options. models.js:214-218. */
export interface ModelGroupOpts {
  readonly required?: boolean;
  readonly kind?: string;
  readonly trial?: boolean;
}

/** `overheadSpan` spec: the keys models.js:300-330 reads, plus any the emitter reads later. */
export type OverheadSpanSpec = {
  readonly clearance: number;
  readonly id?: string;
  readonly frac?: number;
  readonly minimumClearance?: number;
  readonly thickness?: number;
  readonly depth?: number;
  readonly supportGap?: number;
  readonly supportWidth?: number;
  readonly supports?: boolean;
  readonly span?: number;
  readonly offset?: number;
  readonly startLights?: boolean;
  readonly required?: boolean;
} & SceneryOpts;

/** `lampPost` spec: `pos` is required (build-props.js:1886-1894); the rest go to `lampRec`. */
export type LampPostSpec = { readonly pos: RVec3; readonly id?: string } & SceneryOpts;

/** Per-build model diagnostics (build-props.js:307-312; also `__apex.modelDiagnostics()`). */
export interface ModelDiagnostics {
  /** TODO(Phase 3): type the record shapes models.js pushes. */
  readonly emitted: unknown[];
  readonly suppressed: unknown[];
  readonly invalid: unknown[];
  readonly unsafe: unknown[];
  readonly suppressedCounts: { readonly [kind: string]: number };
  readonly supersededByPit: { readonly [kind: string]: number };
}

/** Resolved scenery theme. f1-game js/track/scenery/themes.js:6-18 (`BASE`) and :65 `resolve`. */
export interface SceneryTheme {
  readonly name: string;
  readonly palette: { readonly [key: string]: RVec3 };
  readonly spacing: { readonly furniture: number; readonly service: number };
  readonly budgets: { readonly hero: number; readonly facility: number; readonly repeated: number };
}

/** A LandmarkKit or CircuitKit form: `(stage, spec) -> boolean` (docs/SCENERY-API.md §kits). */
export type KitForm = (stage: SceneryBuffer, spec: SceneryOpts) => boolean;

/** f1-game js/track/scenery/landmark-kit.js: `{ roof, facade, tower, stadiumSection, arch, canopy }`. */
export interface LandmarkKit {
  readonly roof: KitForm;
  readonly facade: KitForm;
  readonly tower: KitForm;
  readonly stadiumSection: KitForm;
  readonly arch: KitForm;
  readonly canopy: KitForm;
}

/** A CircuitKit helper: `(spec) -> boolean`. f1-game js/track/scenery/circuit-kit.js:417-427. */
export type CircuitKitForm = (spec: SceneryOpts) => boolean;

export interface CircuitKit {
  readonly pitBuilding: CircuitKitForm;
  readonly hospitality: CircuitKitForm;
  readonly raceControl: CircuitKitForm;
  readonly pedestrianBridge: CircuitKitForm;
  readonly cameraCrane: CircuitKitForm;
  readonly marshalShelter: CircuitKitForm;
  readonly recoveryBay: CircuitKitForm;
  readonly serviceCompound: CircuitKitForm;
  readonly trackSigns: CircuitKitForm;
}

/** `seat.*`: primitives placed by their FOOT, not their centre. build-props.js:726-732. */
export interface SeatKit {
  box(o: SceneryBuffer, foot: RVec3, sz: RVec3, col: RVec3, basis?: Basis): boolean;
  prism(o: SceneryBuffer, foot: RVec3, sz: RVec3, col: RVec3, basis?: Basis): boolean;
  cyl(o: SceneryBuffer, foot: RVec3, rad: number, h: number, col: RVec3, seg?: number, basis?: Basis): boolean;
  cone(o: SceneryBuffer, foot: RVec3, rad: number, h: number, col: RVec3, seg?: number, basis?: Basis): boolean;
  frustum(o: SceneryBuffer, foot: RVec3, r0: number, r1: number, h: number, col: RVec3, seg?: number, basis?: Basis): boolean;
}

/**
 * The scenery `api`. Emitters typed `void` are ones circuits call for their
 * side effect only; f1-game may return a value there that no circuit uses.
 */
export interface SceneryApi {
  // ── Context (build-props.js:1998-2002) ──────────────────────────────────
  /** Main mesh accumulator. */
  readonly out: SceneryBuffer;
  readonly track: SceneryTrack;
  readonly def: SceneryDef;
  /** `def.theme` (build-props.js:241). */
  readonly theme: string | undefined;
  /** `def.palette`, mutable. */
  readonly pal: SceneryPalette;
  /** Node count. */
  readonly n: number;
  /** Metres per node, `track.total / n`. */
  readonly ds: number;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly hw: Float32Array;
  /** Lowest centreline height on the lap (build-props.js:613-614). */
  readonly pyMin: number;
  /** Lap fraction -> node, un-shifted, sign-safe (build-props.js:1981). */
  K(s: number): number;
  lapBounds(): LapBounds;
  /** Dark session (`track._night ?? def.night`, build-props.js:242). */
  readonly night: boolean;
  readonly MAT: { readonly [M in MatName]: number };
  readonly ATM: { readonly [P in AtmPackName]: AtmPack };
  /** data.js:174-178. */
  readonly COL: { readonly aquaRunoff: RVec3; readonly basinTeal: RVec3; readonly desertSand: RVec3 };
  readonly sceneryTheme: SceneryTheme | null;
  readonly landmarkKit: LandmarkKit | null;
  readonly circuitKit: CircuitKit | null;
  readonly modelDiagnostics: ModelDiagnostics;

  // ── Ground queries ──────────────────────────────────────────────────────
  /** Terrain height `dist` beyond the edge at node `k` (engine frame). build-props.js:616. */
  groundYAt(k: number, dist: number, side?: number): number;
  /** Rendered-terrain height at world XZ, or null off the ribbon. build-props.js:268. */
  terrainYAt(x: number, z: number): number | null;
  /** World-XZ ground: terrainYAt, else nearest node's groundYAt. nature.js:64. */
  groundUnder(x: number, z: number): number;
  frameAt(frac: number): SceneryFrame;
  /** True if (x, z) is within `margin` of any tarmac. guards.js:146. */
  onTrack(x: number, z: number, margin: number, pitMargin?: number): boolean;
  anchor(k: number, side: number, dist: number): SceneryAnchor;
  /** Walk nodes s0 -> s1 (fractions, wraps) ~stepM apart; `fn(k, stepMetres)`. structures.js:82. */
  along(s0: number, s1: number, stepM: number, fn: (k: number, stepMetres: number) => void, tag?: string): void;
  /** Call `fn(k)` every ~`metres` around the lap. build-props.js:1216. */
  every(metres: number, fn: (k: number) => void): void;

  // ── Placement helpers (build-props.js:1175-1290) ─────────────────────────
  place(k: number, side: number, dist: number, sz: RVec3, col: RVec3, deeper?: number): PlaceResult | undefined;
  prop(k: number, side: number, gap: number, sz: RVec3, col: RVec3): PlaceResult | undefined;
  backdrop(k: number, side: number, dist: number, sz: RVec3, col: RVec3): void;
  groundPlane(k: number, side: number, gap: number, sz: RVec3, col: RVec3, water?: boolean): boolean;
  /** Book a footprint so later foliage routes around it. build-props.js:949. */
  indexSolid(s0: number, s1: number, side: number, gap: number, width: number): void;
  /** Register a barrier face (tightens driving limits). build-props.js:940. */
  recordBarrier(s0: number, s1: number, side: number, gap: number): void;
  bakedModel(id: string, k: number, side: number, dist: number, opts?: BakedModelOpts): boolean;

  // ── Guarded primitives: false = dropped (on the road or invalid). build-props.js:472-549 ──
  addBox(o: SceneryBuffer, c: RVec3, sz: RVec3, col: RVec3, basis?: Basis): boolean;
  addPrism(o: SceneryBuffer, c: RVec3, sz: RVec3, col: RVec3, basis?: Basis): boolean;
  addPyramid(o: SceneryBuffer, c: RVec3, sz: RVec3, col: RVec3, basis?: Basis): boolean;
  addCone(o: SceneryBuffer, c: RVec3, rad: number, h: number, col: RVec3, seg?: number, basis?: Basis): boolean;
  addCyl(o: SceneryBuffer, c: RVec3, rad: number, h: number, col: RVec3, seg?: number, basis?: Basis): boolean;
  addFrustum(o: SceneryBuffer, c: RVec3, rBase: number, rTop: number, h: number, col: RVec3, seg?: number, basis?: Basis): boolean;
  /** opts: seg, seed, rough, forest, rock, snow, snowline, lowMat, right, fwd, profile (geom.js:248). */
  addMountain(o: SceneryBuffer, c: RVec3, baseR: number, h: number, opts?: SceneryOpts): boolean;

  // ── Grounding (build-props.js:726-775) ────────────────────────────────────
  readonly seat: SeatKit;
  foundation(o: SceneryBuffer, spec: FoundationSpec): boolean;
  cantilever(
    o: SceneryBuffer, top: RVec3, outM: number, side: number,
    headSz: RVec3, headCol: RVec3, armCol?: RVec3 | null, basis?: Basis,
  ): void;

  // ── Math (geom.js:78-84 cross/norm, :185 vadd; mesh.js:26 upOf, :31 hash; core/mat4.js:6 lerp) ──
  hash(i: number): number;
  upOf(track: SceneryTrack, k: number): Vec3;
  cross(a: RVec3, b: RVec3): Vec3;
  norm(a: RVec3): Vec3;
  lerp(a: number, b: number, t: number): number;
  vadd(p: RVec3, v: RVec3, s: number): Vec3;

  // ── Atomic models (models.js) ────────────────────────────────────────────
  modelGroup(id: string, bounds: ModelBounds, emit: (stage: SceneryBuffer) => boolean | void, opts?: ModelGroupOpts): boolean;
  overheadSpan(spec: OverheadSpanSpec): boolean;
  lampPost(spec: LampPostSpec): boolean;
  /** build-props.js:774; opts: id, required. */
  waterSurface(k: number, side: number, gap: number, sz: RVec3, col: RVec3, opts?: SceneryOpts): boolean;
  /** Returns cells placed. build-props.js:871. */
  waterField(k: number, side: number, gap0: number, gap1: number, halfLen: number, cell: number, col: RVec3, opts?: SceneryOpts): number;
  /** Returns cells placed. build-props.js:876. */
  waterBand(s0: number, s1: number, side: number, gap0: number, gap1: number, cell: number, col: RVec3, opts?: SceneryOpts): number;
  /** opts: material, collision, samples, id (build-props.js:883). */
  groundPatch(k: number, side: number, gap: number, sz: RVec3, col: RVec3, opts?: SceneryOpts): boolean;
  /** spec: points (>= 2), height, width (models.js:536). */
  groundedSegments(spec: SceneryOpts): boolean;
  /** Terrain-fitted flat decal; sz = [depth, thick, len]. models.js:691. */
  drape(k: number, side: number, gap: number, sz: RVec3, col: RVec3, opts?: DrapeOpts): void;
  /** models.js:767. */
  drapeRun(s: number, side: number, gap: number, sz: RVec3, col: RVec3, res: number, span?: number, extra?: DrapeOpts): void;

  // ── Landscape and vegetation (nature.js) ─────────────────────────────────
  pine(k: number, side: number, dist: number, h: number, col: RVec3, opts?: SceneryOpts): void;
  /** opts: crown ("lobed"), variant 0..2, deadChance. nature.js:391. */
  tree(k: number, side: number, dist: number, h: number, col: RVec3, opts?: SceneryOpts): void;
  palm(k: number, side: number, dist: number, h: number, frond: RVec3): void;
  /** opts: form. nature.js:1530. */
  bush(k: number, side: number, dist: number, col: RVec3, opts?: SceneryOpts): void;
  hedge(s0: number, s1: number, side: number, gap: number, h: number, col: RVec3): void;
  /** Deferred to the foliage pass (nature.js:1466 -> forestEdgeNow :1467). opts: density, hMin, hMax, col, col2. */
  forestEdge(s0: number, s1: number, side: number, gap: number, opts?: SceneryOpts): void;
  conifer(k: number, side: number, dist: number, h: number, col: RVec3): void;
  /** opts: slim, trunkCol. */
  cypress(k: number, side: number, dist: number, h: number, col: RVec3, opts?: SceneryOpts): void;
  /** opts: lean, spread, trunkCol. */
  stonePine(k: number, side: number, dist: number, h: number, col: RVec3, opts?: SceneryOpts): void;
  /** opts: lobes, spread, barkCol. */
  broadleafFall(k: number, side: number, dist: number, h: number, col: RVec3, opts?: SceneryOpts): void;
  /** opts: spread, layers, barkCol. */
  acacia(k: number, side: number, dist: number, h: number, col: RVec3, opts?: SceneryOpts): void;
  /** opts: stages, spread, trunkCol. */
  plane(k: number, side: number, dist: number, h: number, col: RVec3, opts?: SceneryOpts): void;
  peak(x: number, z: number, baseY: number, w: number, h: number, col: RVec3): void;
  /** opts: profile ("massif"), stretch, crest. */
  mountain(x: number, z: number, baseY: number, w: number, h: number, opts?: SceneryOpts): void;
  /** opts: profile ("massif"), rough, crest. */
  ridge(x: number, z: number, baseY: number, ang: number, len: number, w: number, h: number, col: RVec3, opts?: SceneryOpts): void;
  /** opts: rows, rise, depth, grass, riser, density, step, crowd, col. */
  spectatorHill(s0: number, s1: number, side: number, gap: number, opts?: SceneryOpts): void;
  /** Legacy 6-arg stand; delegates to grandstandEx. nature.js:1211. */
  grandstand(s: number, side: number, gap: number, len: number, shell?: RVec3 | null, crowd?: RVec3 | null): void;
  /** opts: livery, endWalls, and the §Grandstand variants keys. nature.js:976. */
  grandstandEx(s: number, side: number, gap: number, len: number, shell: RVec3 | null, crowd: RVec3 | null, opts?: SceneryOpts): void;

  // ── Structures (structures.js, city.js, identity.js) ────────────────────
  bleacher(s0: number, s1: number, side: number, gap: number, opts?: SceneryOpts): void;
  scaffoldStand(s0: number, s1: number, side: number, gap: number, opts?: SceneryOpts): void;
  terrace(s0: number, s1: number, side: number, gap: number, opts?: SceneryOpts): void;
  tieredBowl(s0: number, s1: number, side: number, gap: number, opts?: SceneryOpts): void;
  /** opts: wall, window, floor, arch, kind, neon. city.js:161. */
  building(k: number, side: number, gap: number, w: number, h: number, d: number, opts?: SceneryOpts): void;
  house(k: number, side: number, gap: number, w: number, h: number, d: number, opts?: SceneryOpts): void;
  motorhome(k: number, side: number, gap: number, w: number, h: number, d: number, opts?: SceneryOpts): void;
  /** opts: col, seg, cap, capCol, mast. city.js:825. */
  tower(k: number, side: number, dist: number, baseW: number, h: number, opts?: SceneryOpts): void;
  billboard(k: number, side: number, gap: number, w: number, h: number, col: RVec3, opts?: SceneryOpts): void;
  cityFront(s0: number, s1: number, side: number, gap: number, opts?: SceneryOpts): void;
  /** Overhead structure across the track at fraction `s`. structures.js:329. */
  gantry(s: number, h: number, col: RVec3, opts?: SceneryOpts): void;
  marshalPost(k: number, side: number, gap: number, opts?: SceneryOpts): void;
  /** opts: h, col, boom, railCol. */
  cameraTower(k: number, side: number, gap: number, opts?: SceneryOpts): void;
  /** opts: vans, dishes, mastH, vanCol, dishCol, spacing. */
  broadcastCompound(k: number, side: number, gap: number, opts?: SceneryOpts): void;
  /** opts: h, step, palette, postCol. */
  sponsorHoarding(s0: number, s1: number, side: number, gap: number, opts?: SceneryOpts): void;
  /** Seven-segment digit at a world point. structures.js:929. */
  signDigit(c: RVec3, r: RVec3, u: RVec3, t: RVec3, w: number, h: number, proud: number, col: RVec3, digit: number): void;
  /** kind e.g. "braking" / "corner"; value is the number shown. structures.js:938. */
  signBoard(k: number, side: number, gap: number, kind: string, value: number): void;
  ferrisWheel(k: number, side: number, dist: number, radius: number): void;
  /** opts: h, thick, col, pierGap, pierW, depth. identity.js:24. */
  underpassPortal(s: number, opts?: SceneryOpts): void;
  /** opts: h, cool, pool, arms, light. identity.js:62. */
  floodMast(k: number, side: number, dist: number, opts?: SceneryOpts): void;
  /** Both sides every ~stepM; opts forwarded to floodMast (+ dist). identity.js:124. */
  floodMastRing(stepM: number, opts?: SceneryOpts): void;
  /** opts: r, bands, cols, seg, basis. identity.js:133. */
  ledFacadeBands(c: RVec3, h: number, opts?: SceneryOpts): void;
  /** opts: h, thick, col, stripeCol, stripeH, stripeEvery. identity.js:156. */
  concreteCanyon(s0: number, s1: number, side: number, gap: number, opts?: SceneryOpts): void;
  /** opts: rad, rx, rz, h, col, ribs, thick. identity.js:184. */
  sailCanopy(c: RVec3, basis: Basis, opts?: SceneryOpts): void;
  /** opts: w, depth, h, cols, rows, ledCols, strutCol. identity.js:215. */
  gridshellCanopy(c: RVec3, basis: Basis, opts?: SceneryOpts): void;
  /** sz = [depth, thick, len] or a depth. identity.js:255. */
  runoffApron(k: number, side: number, gap: number, sz: RVec3 | number, col: RVec3): void;
  /** opts: saferGap, safer, step, kerbRed, kerbWht, saferCol. identity.js:284. */
  bankedKerbStrip(s0: number, s1: number, side: number, opts?: SceneryOpts): void;
  /** opts: h, thick, shell, step, crowdCols. identity.js:321. */
  bowlSeatWall(s0: number, s1: number, side: number, gap: number, opts?: SceneryOpts): void;
  /** opts: palette, minH, maxH, depth, step, lit, windowCol. identity.js:422. */
  pastelStreetRow(s0: number, s1: number, side: number, gap: number, opts?: SceneryOpts): void;

  // ── Barriers (structures.js:120-330) ────────────────────────────────────
  wall(s0: number, s1: number, side: number, gap: number, h: number, col: RVec3, thick?: number, alt?: number): void;
  fence(s0: number, s1: number, side: number, gap: number, h: number, col: RVec3, opts?: SceneryOpts): void;
  guardrail(s0: number, s1: number, side: number, gap: number, col: RVec3, opts?: SceneryOpts): void;
  tyreWall(s0: number, s1: number, side: number, gap: number, capCol: RVec3, opts?: SceneryOpts): void;
}

/** A circuit's scenery closure. f1-game: `window.TrackScenery[id] = function (api) { ... }`. */
export type SceneryFn = (api: SceneryApi) => void;
