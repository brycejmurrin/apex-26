/**
 * Shared shapes of the ported track engine (f1-game js/track/core/ + js/track/tracks.js).
 *
 * f1-game's `track` is one open object that each build stage adds fields to
 * (tracks.js:157 buildCenterline, :255 buildSteps). Here it is one interface:
 * the centreline fields are required, every later stage's output is optional
 * until that stage has run, exactly as in f1-game.
 */
import type { BuiltDef } from "./def";
import type { BankProfile } from "./mesh";
import type { LineCorner } from "./line";
import type { PitModel } from "./pit";
import type { SurfaceProfile } from "./surface";

/** A mutable 3-vector. f1-game uses plain `[x, y, z]` arrays everywhere. */
export type V3 = [number, number, number];

/** Read-only 3-vector input (colours, directions authored as literals). */
export type RV3 = readonly [number, number, number];

/** Per-vertex material callback (geom.js:32 swayMatAt). */
export type MatAt = (x: number, y: number, z: number) => number;

/**
 * A geometry accumulator: the `{ pos, nrm, col, idx, mat }` buffers every
 * emitter pushes into (geom.js addBox/emit, mesh.js buildRoad, tracks.js
 * buildGate). `_mat` is the current primitive's material id, `_matAt` an
 * optional per-vertex override (geom.js:163 emit).
 */
export interface GeomOut {
  pos: number[];
  nrm: number[];
  col: number[];
  idx: number[];
  mat?: number[];
  _mat?: number;
  _matAt?: MatAt | null;
  /** Upload hints set by tracks.js buildSteps; inert in the port. */
  _keepPositions?: boolean;
  _keepFullGeometry?: boolean;
}

/** The scratch sample `{ p, t, r, hw }` (spline.js:90 sample). */
export interface Sample {
  p: V3;
  t: V3;
  r: V3;
  hw: number;
}

/** A solid post the driving boundary bends around (spline.js:244 postLimits; build-props.js:606). */
export interface Post {
  s: number;
  halfS: number;
  lat: number;
  halfX: number;
  side: number;
}

/** postLimits scratch (spline.js:244). */
export interface PostLimitsOut {
  r: number;
  l: number;
  minOut: number;
  side: number;
}

/** One geometry diagnostics row (tracks.js:299, :325). */
export interface GeometryDiagnostic {
  name: string;
  ok: boolean;
  [key: string]: unknown;
}

/** The terrain spatial grid cached by tracks.js:643 terrainGrid. */
export interface TerrainGrid {
  geo: GeomOut;
  mnx: number;
  mnz: number;
  mxx: number;
  mxz: number;
  nx: number;
  nz: number;
  cell: number;
  cells: (number[] | undefined)[];
}

/** The start gate record (tracks.js:512). */
export interface StartGate {
  c: V3;
  t: V3;
  face: number;
}

/** A built track (f1-game's `track` object). */
export interface Track {
  def: BuiltDef;
  total: number;
  n: number;
  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  tx: Float32Array;
  ty: Float32Array;
  tz: Float32Array;
  rx: Float32Array;
  ry: Float32Array;
  rz: Float32Array;
  hw: Float32Array;
  bank: Float32Array;
  street: boolean;
  /** GPU handles in f1-game; the port keeps CPU geometry in `geo` instead. TODO(lane-render): typed handles. */
  meshes: Record<string, unknown>;
  map: [number, number][] | null;

  /** Static curvature LUT, rad/m per node (tracks.js:161). */
  curv?: Float32Array;

  // ── racing line (line.js bake) ──
  line?: Float32Array | null;
  lineW?: Float32Array;
  lineIn?: Float32Array;
  lineOut?: Float32Array;
  lineK?: Float32Array;
  attackQ?: Float32Array;
  toTurnIn?: Float32Array;
  lineCorners?: LineCorner[];

  /** Banking profile (mesh.js:90 bankingProfile). */
  bankP?: BankProfile | null;
  /** Kerb sides per node (mesh.js buildKerbs). */
  kerbL?: Uint8Array | Float32Array | number[];
  kerbR?: Uint8Array | Float32Array | number[];
  /** Road colour picked by buildRoad (mesh.js). */
  asphaltCol?: RV3;
  /** Node spatial grid cached by mesh.js nodeGrid. */
  _nodeGrid?: unknown;

  pit?: PitModel | null;
  surface?: SurfaceProfile;

  /** Driving boundary per node, set by the scenery build (build-props.js:586). TODO(lane-scenery). */
  barL?: Float32Array;
  barR?: Float32Array;
  posts?: Post[];

  _night?: boolean;
  _gridSlots?: number | null;
  geometryDiagnostics?: GeometryDiagnostic[];
  roadGeo?: GeomOut;
  terrainGeo?: GeomOut;
  propsGeo?: GeomOut | null;
  glassGeo?: GeomOut | null;
  waterGeo?: GeomOut | null;
  _terrGrid?: TerrainGrid;
  propTop?: number;
  startGate?: StartGate;
  buildProfile?: { n: string; k: string; ms: number }[];
  /** The CPU mesh buffers the port's buildTrack returns (f1-game uploads them instead). */
  geo?: TrackGeometry;
}

/** CPU buffers of a full build: what f1-game hands to `gfx.createMesh`. */
export interface TrackGeometry {
  floor: GeomOut;
  road: GeomOut;
  terrain: GeomOut;
  props: GeomOut;
  glass: GeomOut;
  water: GeomOut;
  gate: GeomOut;
  startline: GeomOut;
}
