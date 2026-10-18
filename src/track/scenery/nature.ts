/**
 * SceneryNature: the nature/landscape band of the buildProps composite-model
 * toolkit: the shared trackside `anchor()` plus vegetation (pine, tree, palm,
 * conifer, cypress, stonePine, broadleafFall, acacia, plane, bush, hedge,
 * forestEdge), landforms (peak, mountain, ridge) and crowds (crowdBank,
 * grandstand(Ex), spectatorHill).
 *
 * Port of f1-game js/track/scenery/nature.js:1-1582 (`SceneryNature`),
 * verbatim apart from types. Differences, none of which change output:
 * - Engine globals arrive through `core` (`create(ctx, core)`): `TrackGeom`
 *   is `core.geom`, `TrackMesh` is `core.mesh`, `Tracks` is `core.tracks`
 *   (null = f1-game's `typeof Tracks === "undefined"` branch).
 * - `palmFootprint` / `palmVertices` (nature.js:17-39) read `TrackGeom.vadd`,
 *   so they move inside `create`; `palmBoundsOverlap` / `palmOverlaps`
 *   (:41-52) stay module-level.
 * - The `Log.info` trace at nature.js:60 is dropped.
 * - `TrackSceneryData.*` comes from ./data, `TrackGraph.NODE_COLOR` from ./graph.
 */
import type {
  Basis, MatName, RVec3, SceneryAnchor, SceneryBuffer, SceneryDef, SceneryOpts,
} from "../../contracts/scenery";
import type { Vec3 } from "../../contracts/track";
import type { BuildTrack, NodeGrid, SceneryCore } from "./core";
import { CROWD_DAY, STAND_LIVERIES, STAND_SET_DEF } from "./data";
import type { StandLivery } from "./data";
import { NODE_COLOR } from "./graph";
import type { GraphMeta, GraphPlace, MatAt, ModelBuild } from "./graph";

/** `out` as nature writes it: also the per-vertex material hook `_matAt` (geom.js:178-181). */
export type NatureBuffer = SceneryBuffer & { _matAt?: MatAt | null };

/** A basis the guarded emitters take; `null` = world axes (build-props.js:472-549). */
type OptBasis = Basis | null;

/** build-props.js:570 `instance` opts. */
export interface InstanceOpts {
  readonly buf?: SceneryBuffer;
  readonly unguarded?: boolean;
  readonly roundNormals?: boolean;
}


/** The build-props ctx members nature reads (build-props.js:1336-1361). */
export interface NatureCtx {
  readonly out: NatureBuffer;
  readonly track: BuildTrack;
  readonly n: number;
  readonly ds: number;
  readonly hw: Float32Array;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly NIGHT: boolean;
  readonly MAT: { readonly [M in MatName]: number };
  readonly def: SceneryDef;
  readonly theme: string | undefined;
  /** build-props.js:1142: trunk distance whose crown clears barriers and road, or null. */
  clearTreeDist(k: number, side: number, dist: number, crown: number): number | null;
  addBox(o: SceneryBuffer, c: RVec3, sz: RVec3, col: RVec3, basis?: OptBasis): boolean;
  addCyl(o: SceneryBuffer, c: RVec3, rad: number, h: number, col: RVec3, seg?: number, basis?: OptBasis): boolean;
  addCone(o: SceneryBuffer, c: RVec3, rad: number, h: number, col: RVec3, seg?: number, basis?: OptBasis): boolean;
  addFrustum(o: SceneryBuffer, c: RVec3, rBase: number, rTop: number, h: number, col: RVec3, seg?: number, basis?: OptBasis): boolean;
  addPrism(o: SceneryBuffer, c: RVec3, sz: RVec3, col: RVec3, basis?: OptBasis): boolean;
  addPyramid(o: SceneryBuffer, c: RVec3, sz: RVec3, col: RVec3, basis?: OptBasis): boolean;
  addMountain(o: SceneryBuffer, c: RVec3, baseR: number, h: number, opts?: SceneryOpts): boolean;
  /** geom.js:163. */
  emit(out: SceneryBuffer, verts: readonly RVec3[], col: RVec3, ref?: RVec3 | null): boolean;
  /** guards.js:129: true = the box would sit on the road (drop it). */
  rejBox(c: RVec3, sz: RVec3, basis?: OptBasis): boolean;
  recordBarrier(s0: number, s1: number, side: number, gap: number): void;
  groundYAt(k: number, dist: number, side?: number): number;
  terrainYAt(x: number, z: number): number | null;
  onTrack(x: number, z: number, margin: number, pitMargin?: number): boolean;
  hash(i: number): number;
  upOf(track: BuildTrack, k: number): Vec3;
  norm(a: RVec3): Vec3;
  vadd(p: RVec3, v: RVec3, s: number): Vec3;
  bankOffsetAt(track: BuildTrack, k: number, o: number): number;
  // Read at call time (some are assigned to ctx after nature's create, e.g. `along` by structures.js).
  noteSuppressed(kind: string, msg: string): void;
  /** build-props.js:332: returns the record (TODO(scenery build-props port): type it), or null at the cap. */
  note(kind: string, c: RVec3, size: RVec3, extra?: SceneryOpts): unknown;
  unnote?: (rec: unknown) => void;
  instance(key: string, place: GraphPlace, build: ModelBuild, meta: GraphMeta, opts?: InstanceOpts): number;
  /** build-props.js:1012. */
  massBlocked(c: RVec3, w: number, d: number, b: Basis, shrink?: number): boolean;
  /** build-props.js:1122. */
  barrierClear(x: number, z: number, r: number): boolean;
  /** build-props.js:232. */
  lod(nn: number, floor: number): number;
  indexSolid(s0: number, s1: number, side: number, gap: number, width: number): void;
  /** structures.js:82. */
  along(s0: number, s1: number, stepM: number, fn: (k: number, spacing: number) => void, tag?: string): void;
}

export interface PineOpts { readonly sparse?: boolean; readonly lean?: number; readonly tiers?: number }
export interface TreeOpts {
  readonly crown?: string;
  readonly spread?: number;
  readonly deadChance?: number;
  readonly variant?: number;
  readonly maxDetailed?: number;
}
export interface CypressOpts { readonly slim?: number; readonly trunkCol?: RVec3 }
export interface StonePineOpts { readonly spread?: number; readonly lean?: number; readonly trunkCol?: RVec3 }
export interface BroadleafFallOpts { readonly spread?: number; readonly lobes?: number; readonly barkCol?: RVec3 }
export interface AcaciaOpts { readonly spread?: number; readonly barkCol?: RVec3; readonly layers?: number }
export interface PlaneOpts { readonly spread?: number; readonly stages?: number; readonly trunkCol?: RVec3 }
export interface MountainOpts extends SceneryOpts { readonly rough?: number; readonly forest?: RVec3 }
export interface RidgeOpts { readonly profile?: string; readonly rough?: number; readonly crest?: number }
export interface GrandstandOpts {
  readonly livery?: string;
  readonly roof?: string;
  readonly roofCol?: RVec3;
  readonly fasciaCol?: RVec3;
  readonly tiers?: number;
  readonly h?: number;
  readonly pylons?: boolean;
  readonly suites?: boolean;
  readonly suiteCol?: RVec3;
  readonly endWalls?: boolean;
}
export interface SpectatorHillOpts {
  readonly rows?: number;
  readonly rise?: number;
  /** Deliberately unread (nature.js:1248-1255). */
  readonly h?: number;
  readonly depth?: number;
  readonly grass?: RVec3;
  readonly col?: RVec3;
  readonly riser?: RVec3;
  readonly density?: number;
  readonly step?: number;
  readonly crowd?: readonly RVec3[];
}
export interface ForestEdgeOpts {
  readonly hMin?: number;
  readonly hMax?: number;
  readonly col?: RVec3;
  readonly col2?: RVec3;
  readonly pineFrac?: number;
  readonly density?: number;
  readonly spacing?: number;
  readonly treeOptions?: TreeOpts;
  readonly crown?: string;
  readonly palmFrac?: number;
  readonly palmCol?: RVec3;
}
export interface BushOpts { readonly form?: string; readonly lobes?: number }

export type ForestEdgeArgs = [s0: number, s1: number, side: number, gap: number, opts?: ForestEdgeOpts | null];

/** What `create` returns (nature.js:1573-1577); build-props merges it into ctx. */
export interface NatureApi {
  anchor(kRaw: number, side: number, dist: number): SceneryAnchor;
  groundUnder(x: number, z: number): number;
  pine(k: number, side: number, dist: number, h: number, col: RVec3, opts?: PineOpts | null): void;
  tree(k: number, side: number, dist: number, h: number, col: RVec3, opts?: TreeOpts | null): boolean | undefined;
  palm(k: number, side: number, dist: number, h: number, frond?: RVec3 | null): void;
  conifer(k: number, side: number, dist: number, h: number, col: RVec3): void;
  cypress(k: number, side: number, dist: number, h: number, col: RVec3, opts?: CypressOpts | null): void;
  stonePine(k: number, side: number, dist: number, h: number, col: RVec3, opts?: StonePineOpts | null): void;
  broadleafFall(k: number, side: number, dist: number, h: number, col: RVec3, opts?: BroadleafFallOpts | null): void;
  acacia(k: number, side: number, dist: number, h: number, col: RVec3, opts?: AcaciaOpts | null): void;
  plane(k: number, side: number, dist: number, h: number, col: RVec3, opts?: PlaneOpts | null): void;
  peak(x: number, z: number, baseY: number, w: number, h: number, col: RVec3): void;
  mountain(x: number, z: number, baseY: number, w: number, h: number, opts?: MountainOpts | null): void;
  ridge(x: number, z: number, baseY: number, ang: number, len: number, w: number, h: number, col: RVec3, opts?: RidgeOpts | null): void;
  crowdBank(k: number, side: number, gap: number, len: number, rise: number, depth: number, riserCol?: RVec3 | null, lift?: number): number;
  grandstand(s: number, side: number, gap: number, len: number, shell?: RVec3 | null, crowd?: RVec3 | null): void;
  grandstandEx(s: number, side: number, gap: number, len: number, shell: RVec3 | null | undefined, crowd: RVec3 | null | undefined, opts?: GrandstandOpts | null): void;
  spectatorHill(s0: number, s1: number, side: number, gap: number, opts?: SpectatorHillOpts | null): void;
  bush(k: number, side: number, dist: number, col?: RVec3 | null, opts?: BushOpts | null): void;
  hedge(s0: number, s1: number, side: number, gap: number, h: number, col?: RVec3 | null): void;
  forestEdge(...a: ForestEdgeArgs): void;
  canopyR(kind: string, h: number): number;
  forestEdgeNow(...a: ForestEdgeArgs): void;
  readonly deferredFoliage: ForestEdgeArgs[];
  treeInFootprint(c: RVec3, w: number, h: number, d: number, b: Basis): boolean;
}

type Lobe = readonly [number, number, number, number, number, number];

// Opt-in opaque broadleaf silhouettes, in a 12 m canonical frame. Each
// [x,z,y,radius,lowerRise,capRise] lobe intersects the trunk/other lobes.
// Heights/tints belong to placements, never to the model cache key.
const LOBED_CROWNS: readonly (readonly Lobe[])[] = [
  [[-0.6, -0.2, 3.8, 2.55, 2.4, 3.0], [0.7, 0.45, 4.3, 2.45, 2.7, 3.4], [-0.05, -0.65, 5.2, 2.05, 3.0, 3.8]],
  [[-0.7, 0.35, 3.5, 2.4, 2.5, 3.2], [0.6, -0.5, 4.8, 2.55, 2.2, 3.2], [0.2, 0.3, 5.4, 1.9, 2.8, 3.8]],
  [[-0.3, -0.7, 4.1, 2.6, 2.3, 3.4], [0.65, 0.2, 3.7, 2.35, 2.9, 3.3], [-0.45, 0.4, 5.8, 1.85, 2.4, 3.8]],
];

/** One primitive of a tree/palm assembly (nature.js:320-323, :584-601). */
interface PalmPart {
  readonly type: "cyl" | "box" | "prism" | "frustum" | "cone";
  readonly c: RVec3;
  readonly size: RVec3;
  readonly b: Basis;
  readonly col?: RVec3;
}

/** An axis-aligned envelope palmBoundsOverlap compares (a footprint or a whole site). */
interface PalmBounds {
  readonly c: RVec3;
  readonly ex: number;
  readonly ez: number;
  readonly minY: number;
  readonly maxY: number;
}

/** palmFootprint's result: an oriented XZ rectangle plus its envelope. nature.js:26-28. */
interface Footprint extends PalmBounds {
  readonly w: number;
  readonly d: number;
  readonly b: Basis;
}

/** A planted tree/palm: its part footprints and their union envelope. nature.js:365, :651. */
interface Site extends PalmBounds {
  readonly parts: Footprint[];
  readonly relocated: boolean;
}

/** A pine tier facet plane [nx, ny, nz, d]. nature.js:240. */
type Facet = [number, number, number, number];

// nature.js:41-42.
const palmBoundsOverlap = (a: PalmBounds, b: PalmBounds) => Math.abs(a.c[0] - b.c[0]) <= a.ex + b.ex &&
  Math.abs(a.c[2] - b.c[2]) <= a.ez + b.ez && a.minY <= b.maxY && b.minY <= a.maxY;

// nature.js:44-52.
function palmOverlaps(a: Footprint, b: Footprint): boolean {
  if (!palmBoundsOverlap(a, b)) return false;
  const dx = a.c[0] - b.c[0], dz = a.c[2] - b.c[2];
  return [a.b[0], a.b[2], b.b[0], b.b[2]].every((axis) => {
    const reach = (f: Footprint) => (f.w * Math.abs(f.b[0][0] * axis[0] + f.b[0][2] * axis[2]) +
                          f.d * Math.abs(f.b[2][0] * axis[0] + f.b[2][2] * axis[2])) / 2;
    return Math.abs(dx * axis[0] + dz * axis[2]) <= reach(a) + reach(b);
  });
}

export function create(ctx: NatureCtx, core: SceneryCore): NatureApi {
  const TrackGeom = core.geom, TrackMesh = core.mesh, Tracks = core.tracks;
  const { out, track, n, ds, hw, px, py, pz, NIGHT, MAT, def,
          clearTreeDist,
          addBox, addCyl, addCone, addFrustum, addPrism, addPyramid,
          addMountain, emit, rejBox, recordBarrier, groundYAt,
          terrainYAt, onTrack, hash, upOf, norm, vadd, bankOffsetAt } = ctx;

  // Project every axis onto an orthonormal XZ frame, including leaned trunks
  // and drooping prism up-axes. Cylinders/prisms are base-anchored; boxes are
  // centre-anchored. These rectangles contain every vertex of each primitive.
  // nature.js:17-29.
  function palmFootprint(part: PalmPart): Footprint {
    const [r, u, t] = part.b, [w, h, d] = part.size;
    const L = Math.hypot(r[0], r[2]) || 1;
    const rx: Vec3 = [r[0] / L, 0, r[2] / L], tz: Vec3 = [-rx[2], 0, rx[0]];
    const proj = (v: RVec3, axis: RVec3) => Math.abs(v[0] * axis[0] + v[2] * axis[2]);
    const c = part.type === "box" ? part.c : TrackGeom.vadd(part.c, u, h / 2);
    const fw = w * proj(r, rx) + h * proj(u, rx) + d * proj(t, rx);
    const fd = w * proj(r, tz) + h * proj(u, tz) + d * proj(t, tz);
    const ey = (w * Math.abs(r[1]) + h * Math.abs(u[1]) + d * Math.abs(t[1])) / 2;
    return { c, w: fw, d: fd, b: [rx, [0, 1, 0], tz], minY: c[1] - ey, maxY: c[1] + ey,
      ex: (fw * Math.abs(rx[0]) + fd * Math.abs(tz[0])) / 2,
      ez: (fw * Math.abs(rx[2]) + fd * Math.abs(tz[2])) / 2 };
  }

  // nature.js:31-39.
  function palmVertices(part: PalmPart): Vec3[] {
    const [r, u, t] = part.b, [w, h, d] = part.size, verts: Vec3[] = [];
    for (const z of [-d / 2, d / 2]) {
      for (const x of [-w / 2, w / 2]) for (const y of part.type === "box" ? [-h / 2, h / 2] : [0])
        verts.push(TrackGeom.vadd(TrackGeom.vadd(TrackGeom.vadd(part.c, r, x), u, y), t, z));
      if (part.type === "prism") verts.push(TrackGeom.vadd(TrackGeom.vadd(part.c, u, h), t, z));
    }
    return verts;
  }

  // nature.js:63-90.
  const _guCand = new Array<number>(n);
  const groundUnder = (x: number, z: number): number => {
    const ty = terrainYAt(x, z);
    if (ty !== null) return ty;
    let best = 0, bestD = Infinity;
    const grid = (track["_nodeGrid"] as NodeGrid | null | undefined) || TrackMesh.nodeGrid(track);
    if (grid && grid.query) {
      let R = 40;
      for (;;) {
        const cnt = grid.query(x, z, R, _guCand, false);
        best = 0; bestD = Infinity;
        for (let a = 0; a < cnt; a++) {
          const i = _guCand[a]!;
          const d = (x - px[i]!) * (x - px[i]!) + (z - pz[i]!) * (z - pz[i]!);
          if (d < bestD) { bestD = d; best = i; }
        }
        if (cnt > 0 && bestD <= R * R) break;
        if (R > 8000) break;
        R *= 2;
      }
    } else {
      for (let i = 0; i < n; i++) {
        const d = (x - px[i]!) * (x - px[i]!) + (z - pz[i]!) * (z - pz[i]!);
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    return groundYAt(best, Math.max(0, Math.sqrt(bestD) - hw[best]!));
  };

  // nature.js:92-131.
  const anchor = (kRaw: number, side: number, dist: number): SceneryAnchor => {
    const k = Math.round(((kRaw % n) + n) % n) % n;
    const r: Vec3 = [track.rx[k]!, track.ry[k]!, track.rz[k]!];
    const t: Vec3 = [track.tx[k]!, track.ty[k]!, track.tz[k]!];
    const u = upOf(track, k);
    const o = side * (hw[k]! + dist);
    const cx = px[k]! + r[0] * o, cz = pz[k]! + r[2] * o;
    // Sit on the ACTUAL rendered terrain when available; inside the
    // road-to-ribbon gap (< 2.2 m) the ground is the ROAD SURFACE, pivoted by
    // the bank (nature.js:99-122 has the full rationale).
    const base = dist < 2.2
      ? py[k]! + bankOffsetAt(track, k, o)
      : (() => { const ty = terrainYAt(cx, cz);
                 return ty != null ? ty : groundYAt(k, dist) + bankOffsetAt(track, k, o); })();
    // `k` is the RESOLVED node — on a shifted/reversed circuit the wrapper
    // remapped the caller's index, so a circuit pairing this anchor with an
    // unwrapped node query (groundYAt) must read the node from here.
    return { c: [cx, base - 0.3, cz], r, u, t, k };
  };
  // ONE TREE PER SPOT (nature.js:132-143): a RADIUS, not a cell; no two real
  // trunks stand closer than TREE_GAP.
  const TREE_GAP = 1.0;
  const planted = new Map<string, [number, number][]>();   // 1 m cell -> [[x, z], …]
  // LAYERED-BANK SLOT (nature.js:145-152): counts CALLS, not heights.
  let hillSeq = 0, standSeq = 0;
  const spotOccupied = (x: number, z: number, reserve = true): boolean => {
    const cx = Math.floor(x / TREE_GAP), cz = Math.floor(z / TREE_GAP);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const cell = planted.get(`${cx + i}|${cz + j}`);
      if (cell) for (const q of cell)
        if (Math.hypot(q[0] - x, q[1] - z) < TREE_GAP) return true;
    }
    if (!reserve) return false;
    const key = `${cx}|${cz}`;
    if (!planted.has(key)) planted.set(key, []);
    planted.get(key)!.push([x, z]);
    return false;
  };
  const spotTaken = (x: number, z: number) => spotOccupied(x, z);
  // Placed pines' tier-cone facet planes [nx, ny, nz, d], bucketed on a
  // 10 m grid, for pine()'s coplanar guard.
  interface PineFacetRec { x: number; z: number; reach: number; facets: Facet[] }
  const PINE_CELL = 10, pineFacetGrid = new Map<string, PineFacetRec[]>();
  const pineFacetsNear = (x: number, z: number, reach: number): Facet[][] => {
    const res: Facet[][] = [], cx = Math.floor(x / PINE_CELL), cz = Math.floor(z / PINE_CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const cell = pineFacetGrid.get(`${cx + i}|${cz + j}`);
      if (cell) for (const q of cell)
        if (Math.hypot(q.x - x, q.z - z) < q.reach + reach) res.push(q.facets);
    }
    return res;
  };
  const pineFacetsAdd = (x: number, z: number, reach: number, facets: Facet[]) => {
    const key = `${Math.floor(x / PINE_CELL)}|${Math.floor(z / PINE_CELL)}`;
    if (!pineFacetGrid.has(key)) pineFacetGrid.set(key, []);
    pineFacetGrid.get(key)!.push({ x, z, reach, facets });
  };
  // nature.js:185-278.
  const pine = (k: number, side: number, dist: number, h: number, col: RVec3, opts?: PineOpts | null): void => {
    opts = opts || {};
    const a = anchor(k, side, dist);
    if (spotTaken(a.c[0], a.c[2])) return;
    // The CROWN's radius from the pit complex, not the trunk's (nature.js:189-194).
    if (onTrack(a.c[0], a.c[2], 3, Math.max(0.5, h * 0.225))) {
      ctx.noteSuppressed("pine", `pine SUPPRESSED at k=${k} side=${side}: dist=${dist}`);
      return;
    }
    ctx.note("pine", [a.c[0], a.c[1] + h / 2, a.c[2]], [h * 0.45, h, h * 0.45], { k, side });
    // per-instance size jitter so a treeline doesn't read as identical clones
    const j = 0.85 + hash(k * 3.7 + side * 1.3 + dist) * 0.3;
    const vr = hash(k * 6.1 + side * 4.4 + dist + 9.3);
    const sparse = opts.sparse != null ? !!opts.sparse : vr > 0.82;   // ~18% thinner 3-tier trees
    const lean = opts.lean != null ? opts.lean
      : (!sparse && vr > 0.55 ? (vr - 0.55) * 2.2 : 0);              // ~27% windswept lean
    const tiers = opts.tiers != null ? Math.max(2, Math.min(6, Math.round(opts.tiers)))
      : (sparse ? 3 : 4);
    const PINE_REF_H = 12;
    const jQ = 0.85 + Math.round((j - 0.85) / 0.15) * 0.15;
    const leanQ = lean <= 0 ? 0 : Math.round(lean / 0.4) * 0.4;
    const s = h / PINE_REF_H;
    const o: Vec3 = [a.c[0] - a.u[0] * 0.5, a.c[1] - a.u[1] * 0.5, a.c[2] - a.u[2] * 0.5];
    const r: Vec3 = side < 0 ? [-a.r[0], -a.r[1], -a.r[2]] : a.r;
    // COPLANAR GUARD (nature.js:214-223): sink this tree by the first SEP slot
    // that keeps each tier facet >= MIN_SEP off every parallel facet of an
    // overlapping neighbour.
    const facets: Facet[] = [];
    {
      const H = PINE_REF_H, w0 = (sparse ? 2.3 : 2.7) * jQ, dy = H * (sparse ? 0.24 : 0.18) * jQ;
      const W = (m: RVec3): Vec3 => [o[0] + s * (r[0] * m[0] + a.u[0] * m[1] + a.t[0] * m[2]),
                                     o[1] + s * (r[1] * m[0] + a.u[1] * m[1] + a.t[1] * m[2]),
                                     o[2] + s * (r[2] * m[0] + a.u[2] * m[1] + a.t[2] * m[2])];
      let y = H * 0.3 + 0.5;
      for (let i = 0; i < tiers; i++, y += dy) {
        const w = w0 * (1 - i * (sparse ? 0.24 : 0.21)), lx = leanQ ? leanQ * (y / H) * 1.6 : 0;
        const ap = W([lx, y + H * 0.32, 0]);
        for (let f = 0; f < 7; f++) {
          const a0 = f / 7 * 6.2832, a1 = (f + 1) / 7 * 6.2832;
          const p0 = W([lx + Math.cos(a0) * w, y, Math.sin(a0) * w]);
          const p1 = W([lx + Math.cos(a1) * w, y, Math.sin(a1) * w]);
          const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]] as const, e2 = [ap[0] - p0[0], ap[1] - p0[1], ap[2] - p0[2]] as const;
          const n = norm([e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]);
          facets.push([n[0], n[1], n[2], n[0] * ap[0] + n[1] * ap[1] + n[2] * ap[2]]);
        }
      }
    }
    const reach = ((sparse ? 2.3 : 2.7) * jQ + leanQ * 1.6) * s;
    const near = pineFacetsNear(a.c[0], a.c[2], reach);
    let dz = 0;
    if (near.length) {
      const clash = (d: number) => {
        for (const q of near) for (const F of facets) for (const G of q) {
          if (Math.abs(F[0] * G[0] + F[1] * G[1] + F[2] * G[2]) < 0.999) continue;
          const dF = F[3] - d * F[1], sgn = F[0] * G[0] + F[1] * G[1] + F[2] * G[2] > 0 ? 1 : -1;
          if (Math.abs(dF - sgn * G[3]) < TrackGeom.MIN_SEP) return true;
        }
        return false;
      };
      for (let i = 0; clash(dz) && i < 12; i++) dz = TrackGeom.SEP_SLOTS[i % 4]! + Math.floor(i / 4) * 0.2;
    }
    if (dz) { o[1] -= dz; for (const F of facets) F[3] -= dz * F[1]; }
    pineFacetsAdd(a.c[0], a.c[2], reach, facets);
    ctx.instance(
      `pine|${sparse ? 1 : 0}|${tiers}|${leanQ}|${jQ}`,
      { o, r, u: a.u, t: a.t, s: [s, s, s], col },
      (rec) => {
        const H = PINE_REF_H;
        rec.mat(MAT.WOOD);
        rec.cyl([0, 0, 0], 0.35 + H * 0.02, H * 0.4 + 0.5, [0.30, 0.22, 0.13], 6);
        rec.mat(MAT.FOLIAGE, [H * 0.32, H * 1.15]);   // wind-sway weight: 0 at the lowest tier, 1 at the tip
        let y = H * 0.3 + 0.5;
        for (let i = 0; i < tiers; i++) {
          const w = (sparse ? 2.3 : 2.7) * jQ * (1 - i * (sparse ? 0.24 : 0.21));
          rec.cone([leanQ ? leanQ * (y / H) * 1.6 : 0, y, 0],
                   w, H * 0.32, NODE_COLOR, 7);
          y += H * (sparse ? 0.24 : 0.18) * jQ;
        }
      },
      { kind: "pine", k, side, h });
    out._mat = 0;
  };
  // WIND SWAY + CROWN ROUNDING (nature.js:279-297): FOLIAGE emitted while
  // out._matAt is set carries a per-vertex sway weight; swayOff() clears it
  // and rounds the crown's normals (TrackGeom.roundNormals).
  let _crownV0 = -1, _crownBase: RVec3 | null = null, _crownUp: RVec3 | null = null;
  const swayOn = (base: RVec3, up: RVec3, y0: number, y1: number) => {
    out._matAt = TrackGeom.swayMatAt(MAT.FOLIAGE, base, up, y0, y1);
    _crownV0 = out.pos.length / 3; _crownBase = base; _crownUp = up;
  };
  const swayOff = () => {
    out._matAt = null;
    if (_crownV0 >= 0) TrackGeom.roundNormals(out, _crownV0, _crownBase!, _crownUp!);
    _crownV0 = -1; _crownBase = null; _crownUp = null;
  };
  // Authored woodland may interlock. Relocations claim complete tree parts
  // so a later row cannot move its matching facet planes into that tree.
  const TREE_CELL = 24, placedTrees = new Map<string, Site[]>();
  const treeOccupied = (f: Footprint, relocated: boolean) => {
    const seen = new Set<Site>();
    for (let x = Math.floor((f.c[0] - f.ex) / TREE_CELL); x <= Math.floor((f.c[0] + f.ex) / TREE_CELL); x++)
      for (let z = Math.floor((f.c[2] - f.ez) / TREE_CELL); z <= Math.floor((f.c[2] + f.ez) / TREE_CELL); z++)
        for (const site of placedTrees.get(`${x}|${z}`) || []) {
          if (seen.has(site) || (!relocated && !site.relocated)) continue;
          seen.add(site);
          if (palmBoundsOverlap(f, site) && site.parts.some((p) => palmOverlaps(f, p))) return true;
        }
    return false;
  };
  // nature.js:312-376.
  const lobedTree = (k: number, side: number, dist: number, h: number, col: RVec3, opts: TreeOpts, vr: number): boolean => {
    const variant = opts.variant === undefined ? Math.floor(vr * 3) : opts.variant;
    if (!Number.isFinite(h) || h <= 0 || !Number.isInteger(variant) || variant < 0 || variant > 2 ||
        (opts.spread !== undefined && opts.spread !== 1) ||
        !Array.isArray(col) || col.length !== 3 || !col.every(Number.isFinite)) return false;
    const a = anchor(k, side, dist), b: Basis = [a.r, a.u, a.t], s = h / 12;
    const o = vadd(a.c, a.u, -0.5), lobes = LOBED_CROWNS[variant]!;
    const at = (x: number, y: number, z: number) => vadd(vadd(vadd(o, a.r, x * s), a.u, y * s), a.t, z * s);
    const parts: PalmPart[] = [{ type: "cyl", c: o, size: [0.8 * s, 6.7 * s, 0.8 * s], b }];
    for (const [x, z, y, radius, lower, cap] of lobes) {
      parts.push({ type: "frustum", c: at(x, y, z), size: [radius * 2 * s, lower * s, radius * 2 * s], b });
      parts.push({ type: "cone", c: at(x, y + lower, z), size: [radius * 2 * s, cap * s, radius * 2 * s], b });
    }
    const footprints = parts.map(palmFootprint);
    // A complete tree or nothing: test the actual tilted part envelopes
    // before graph replay, including crown terrain on all four rim corners.
    const clear = footprints.every((f, i) => {
      if (rejBox(f.c, [f.w, f.maxY - f.minY, f.d], f.b) ||
          ctx.massBlocked(f.c, f.w, f.d, f.b, 1) || treeOccupied(f, false) ||
          !ctx.barrierClear(f.c[0], f.c[2], Math.hypot(f.w, f.d) / 2)) return false;
      if (!i) return true;
      const p = parts[i]!, half = p.size[0] / 2;
      for (const [x, z] of [[0, 0], [-half, -half], [-half, half], [half, -half], [half, half]] satisfies [number, number][]) {
        const q = vadd(vadd(p.c, a.r, x), a.t, z), ground = terrainYAt(q[0], q[2]);
        if (ground != null && ground > q[1] + 0.02) return false;
      }
      return true;
    });
    if (!clear) {
      ctx.noteSuppressed("tree", `lobed tree SUPPRESSED at k=${k} side=${side}: dist=${dist}`);
      return false;
    }
    if (spotOccupied(a.c[0], a.c[2], false)) return false;
    const segments = ctx.lod(4, 3), trunkSegments = ctx.lod(5, 4);
    // `whole`: graph.instance dry-runs the guarded primitives once and plants
    // nothing unless every one passes, then reuses those verdicts (#2178).
    const landed = ctx.instance(`tree-lobed|${variant}|${segments}`, {
      o, r: a.r, u: a.u, t: a.t, s: [s, s, s], col,
    }, (rec) => {
      rec.mat(MAT.WOOD);
      rec.cyl([0, 0, 0], 0.4, 6.7, [0.32, 0.23, 0.13], trunkSegments);
      rec.mat(MAT.FOLIAGE, [3.5, 12]);
      for (const [x, z, y, radius, lower, cap] of lobes) {
        rec.frustum([x, y, z], 0.08, radius, lower, NODE_COLOR, segments);
        rec.cone([x, y + lower, z], radius, cap, NODE_COLOR, segments);
      }
    }, { kind: "tree", k, side, h, crown: "lobed", variant, whole: true }, { roundNormals: true });
    out._mat = 0; out._matAt = null;
    if (!landed) return false;
    spotTaken(a.c[0], a.c[2]);
    const minX = Math.min(...footprints.map((f) => f.c[0] - f.ex)), maxX = Math.max(...footprints.map((f) => f.c[0] + f.ex));
    const minZ = Math.min(...footprints.map((f) => f.c[2] - f.ez)), maxZ = Math.max(...footprints.map((f) => f.c[2] + f.ez));
    const minY = Math.min(...footprints.map((f) => f.minY)), maxY = Math.max(...footprints.map((f) => f.maxY));
    const site: Site = { parts: footprints, relocated: false, c: [(minX + maxX) / 2, 0, (minZ + maxZ) / 2],
      ex: (maxX - minX) / 2, ez: (maxZ - minZ) / 2, minY, maxY };
    for (let x = Math.floor(minX / TREE_CELL); x <= Math.floor(maxX / TREE_CELL); x++)
      for (let z = Math.floor(minZ / TREE_CELL); z <= Math.floor(maxZ / TREE_CELL); z++) {
        const key = `${x}|${z}`;
        if (!placedTrees.has(key)) placedTrees.set(key, []);
        placedTrees.get(key)!.push(site);
      }
    ctx.note("tree", [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
      [maxX - minX, maxY - minY, maxZ - minZ], { k, side, dist, crown: "lobed", variant });
    return true;
  };
  // The same registry answers LATER masses (city towers are built after the
  // closure's trees and massBlocked never saw a tree): is any planted tree's
  // trunk or crown inside this box (centre c, w x h x d, basis b)? nature.js:380.
  const treeInFootprint = (c: RVec3, w: number, h: number, d: number, b: Basis): boolean => {
    const f = palmFootprint({ type: "box", c, size: [w, h, d], b }), seen = new Set<Site>();
    for (let x = Math.floor((f.c[0] - f.ex) / TREE_CELL); x <= Math.floor((f.c[0] + f.ex) / TREE_CELL); x++)
      for (let z = Math.floor((f.c[2] - f.ez) / TREE_CELL); z <= Math.floor((f.c[2] + f.ez) / TREE_CELL); z++)
        for (const site of placedTrees.get(`${x}|${z}`) || []) {
          if (seen.has(site)) continue;
          seen.add(site);
          if (palmBoundsOverlap(f, site) && site.parts.some((p) => palmOverlaps(f, p))) return true;
        }
    return false;
  };
  // nature.js:391-562.
  const tree = (k: number, side: number, dist: number, h: number, col: RVec3, opts?: TreeOpts | null): boolean | undefined => {
    const crown = (opts && opts.crown) || "round";
    const sp = (opts && opts.spread) || 1;
    const initialDist = dist;
    // Relocation changes the anchor, never this tree's authored shape seed.
    const vr = hash(k * 8.3 + side * 5.1 + initialDist + 4.7);
    const deadAt = 1 - ((opts && opts.deadChance != null) ? opts.deadChance : 0.09);
    if (crown === "lobed" && vr <= deadAt) return lobedTree(k, side, dist, h, col, opts!, vr);
    const j = 0.85 + hash(k * 2.9 + side * 1.7 + initialDist) * 0.3;
    const lean = vr > 0.55 ? (vr - 0.55) * 1.4 : 0;
    const partsAt = (p: SceneryAnchor): PalmPart[] => {
      const basis: Basis = [p.r, p.u, p.t], parts: PalmPart[] = [];
      const part = (type: PalmPart["type"], y: number, radius: number, height: number, x = 0, bb = basis) =>
        parts.push({ type, c: vadd(vadd(p.c, p.u, y), p.r, x), size: [radius * 2, height, radius * 2], b: bb });
      if (vr > deadAt) {
        part("cyl", -0.5, 0.32, h * 0.7 + 0.5);
        for (let i = 0; i < 3; i++) {
          const bh = hash(k * 11 + i * 3.1 + initialDist), angle = (i / 3 + bh * 0.4) * 6.2832;
          const bu = p.u.map((v, axis) => v * 0.7 + (p.r[axis]! * Math.cos(angle) + p.t[axis]! * Math.sin(angle)) * 0.7) as Vec3;
          part("cyl", h * 0.7 + i * 0.25, 0.09, 1.6 + bh * 1.4, 0, [p.r, bu, p.t]);
        }
      } else {
        part("cyl", -0.5, 0.4, h * 0.55 + 0.5);
        part("cone", h * 0.20, (3.5 + h * 0.135) * j, h * 0.14); // entire understorey skirt
        if (crown === "vase") {
          part("cone", h * 0.34, (2.1 + h * 0.07) * j * sp, h * 0.28);
          part("cone", h * 0.56, (3.4 + h * 0.15) * j * sp, h * 0.28);
          part("cone", h * 0.78, (4.0 + h * 0.17) * j * sp, h * 0.24, lean);
        } else if (crown === "weeping") {
          part("cone", h * 0.62, (3.6 + h * 0.15) * j * sp, h * 0.30);
          part("frustum", h * 0.24, (3.9 + h * 0.16) * j * sp, h * 0.40);
        } else if (crown === "columnar") {
          part("cone", h * 0.30, (1.5 + h * 0.05) * j * sp, h * 0.36);
          part("cone", h * 0.56, (1.2 + h * 0.04) * j * sp, h * 0.34);
          part("cone", h * 0.80, (0.8 + h * 0.03) * j * sp, h * 0.26);
        } else {
          part("cone", h * 0.28, (3.3 + h * 0.13) * j * sp, h * 0.30);
          part("cone", h * 0.46, (3.7 + h * 0.14) * j * sp, h * 0.26);
          part("cone", h * 0.66, (2.9 + h * 0.10) * j * sp, h * 0.26, lean);
          part("cone", h * 0.82, (1.7 + h * 0.06) * j * sp, h * 0.22, lean * 1.6);
        }
      }
      return parts;
    };
    const clearAt = (p: SceneryAnchor, relocated = false) => !onTrack(p.c[0], p.c[2], 4, Math.max(0.5, h * 0.3 * sp)) &&
      partsAt(p).every((part) => {
        const f = palmFootprint(part);
        return !ctx.massBlocked(f.c, f.w, f.d, f.b, 1) &&
          !treeOccupied(f, relocated) &&
          ctx.barrierClear(f.c[0], f.c[2], Math.hypot(f.w, f.d) / 2) &&
          !rejBox(f.c, [f.w, f.maxY - f.minY, f.d], f.b);
      });
    let a = anchor(k, side, dist);
    if (!clearAt(a)) {
      let found = false;
      for (let extra = 1.5; extra <= 12; extra += 1.5) {
        dist = initialDist + extra;
        a = anchor(k, side, dist);
        if (clearAt(a, true)) { found = true; break; }
      }
      if (!found) {
        ctx.noteSuppressed("tree", `tree SUPPRESSED by occupied ground at k=${k} side=${side}: dist=${initialDist}`);
        return;
      }
    }
    const b: Basis = [a.r, a.u, a.t];
    if (spotTaken(a.c[0], a.c[2])) return;   // reserve only the successful site
    const reserve = () => {
      const parts = partsAt(a).map(palmFootprint);
      const minX = Math.min(...parts.map((f) => f.c[0] - f.ex)), maxX = Math.max(...parts.map((f) => f.c[0] + f.ex));
      const minZ = Math.min(...parts.map((f) => f.c[2] - f.ez)), maxZ = Math.max(...parts.map((f) => f.c[2] + f.ez));
      const site: Site = { parts, relocated: dist !== initialDist, c: [(minX + maxX) / 2, 0, (minZ + maxZ) / 2],
        ex: (maxX - minX) / 2, ez: (maxZ - minZ) / 2,
        minY: Math.min(...parts.map((f) => f.minY)), maxY: Math.max(...parts.map((f) => f.maxY)) };
      for (let x = Math.floor(minX / TREE_CELL); x <= Math.floor(maxX / TREE_CELL); x++)
        for (let z = Math.floor(minZ / TREE_CELL); z <= Math.floor(maxZ / TREE_CELL); z++) {
          const key = `${x}|${z}`;
          if (!placedTrees.has(key)) placedTrees.set(key, []);
          placedTrees.get(key)!.push(site);
        }
    };
    // Noted BEFORE the trunk (note() owns the primitives that follow); a
    // refused trunk takes the note back (H26b). nature.js:472-479.
    const treeRec = ctx.note("tree", [a.c[0], a.c[1] + h / 2, a.c[2]], [h * 0.5, h, h * 0.5], { k, side, dist, initialDist });
    const refuseTree = () => { out._mat = 0; if (ctx.unnote) ctx.unnote(treeRec); };
    if (vr > deadAt) {   // dead/storm tree: bare trunk + a few angled branch stubs.
      const th = h * 0.7;
      out._mat = MAT.WOOD;
      if (addCyl(out, vadd(a.c, a.u, -0.5), 0.32, th + 0.5, [0.28, 0.22, 0.16], 6, b) === false) { refuseTree(); return; }   // no trunk, no crown (the pit complex keeps footings out)
      const top = vadd(a.c, a.u, th);
      for (let i = 0; i < 3; i++) {
        const bh = hash(k * 11 + i * 3.1 + initialDist);
        const ang = (i / 3 + bh * 0.4) * 6.2832;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const bu: Vec3 = [
          a.u[0] * 0.7 + (a.r[0] * ca + a.t[0] * sa) * 0.7,
          a.u[1] * 0.7 + (a.r[1] * ca + a.t[1] * sa) * 0.7,
          a.u[2] * 0.7 + (a.r[2] * ca + a.t[2] * sa) * 0.7
        ];
        addCyl(out, vadd(top, a.u, i * 0.25), 0.09, 1.6 + bh * 1.4, [0.30, 0.24, 0.17], 4, [a.r, bu, a.t]);
      }
      reserve();
      out._mat = 0;
      return;
    }
    // per-instance jitter so adjacent broadleaves vary in size/shape
    const c2: Vec3 = [col[0] * 0.88, col[1] * 0.9, col[2] * 0.84];   // sunlit upper foliage
    out._mat = MAT.WOOD;
    if (addCyl(out, vadd(a.c, a.u, -0.5), 0.4, h * 0.55 + 0.5, [0.32, 0.23, 0.13], 6, b) === false) { refuseTree(); return; }   // no trunk, no crown (the pit complex keeps footings out)
    out._mat = MAT.FOLIAGE;
    swayOn(a.c, a.u, h * 0.22, h * 1.0);
    {
      const usR = (3.5 + h * 0.135) * j;
      const ringY = h * 0.34, apexY = h * 0.20;
      const usCol: Vec3 = [col[0] * 0.5, col[1] * 0.52, col[2] * 0.5];
      const uref = vadd(a.c, a.u, h * 0.7);
      const apex = vadd(a.c, a.u, apexY);
      const ring = (ang: number) => vadd(vadd(vadd(a.c, a.u, ringY), a.r, Math.cos(ang) * usR), a.t, Math.sin(ang) * usR);
      // A wedge whose whole TOP is under the terrain is hidden: drop it
      // instead of emitting buried triangles (nature.js:513-520).
      const hidden = (tri: readonly [Vec3, Vec3, Vec3]) => {
        const top = Math.max(tri[0][1], tri[1][1], tri[2][1]) - 0.02;
        let sx = 0, sy = 0, sz = 0, m = 0, seen = 0;
        const under = (x: number, y: number, z: number) => { const ty = terrainYAt(x, z); if (ty === null) return true; seen++; return ty > y; };
        for (const p of tri) {
          if (p[1] < top) continue;
          if (!under(p[0], p[1], p[2])) return false;
          sx += p[0]; sy += p[1]; sz += p[2]; m++;
        }
        return under(sx / m, sy / m, sz / m) && seen > 0;
      };
      for (let i = 0; i < 9; i++) {
        const a0 = i / 9 * 6.2832, a1 = (i + 1) / 9 * 6.2832;
        const tri = [ring(a0), ring(a1), apex] as const;
        if (hidden(tri)) continue;
        emit(out, tri, usCol, uref);
      }
    }
    if (crown === "vase") {
      // Eucalyptus / elm: narrow at the fork, spreading upward and outward.
      addCone(out, vadd(a.c, a.u, h * 0.34), (2.1 + h * 0.07) * j * sp, h * 0.28, col, 8, b);
      addCone(out, vadd(a.c, a.u, h * 0.56), (3.4 + h * 0.15) * j * sp, h * 0.28, col, 9, b);
      addCone(out, vadd(vadd(a.c, a.u, h * 0.78), a.r, lean), (4.0 + h * 0.17) * j * sp, h * 0.24, c2, 9, b);
    } else if (crown === "weeping") {
      // Willow: a high dome with the mass hanging BELOW it.
      addCone(out, vadd(a.c, a.u, h * 0.62), (3.6 + h * 0.15) * j * sp, h * 0.30, col, 9, b);
      addFrustum(out, vadd(a.c, a.u, h * 0.24), (1.4 + h * 0.05) * j * sp,
        (3.9 + h * 0.16) * j * sp, h * 0.40, c2, 9, b);
    } else if (crown === "columnar") {
      // Poplar / lombardy: a tall narrow spire, almost no spread.
      addCone(out, vadd(a.c, a.u, h * 0.30), (1.5 + h * 0.05) * j * sp, h * 0.36, col, 7, b);
      addCone(out, vadd(a.c, a.u, h * 0.56), (1.2 + h * 0.04) * j * sp, h * 0.34, col, 7, b);
      addCone(out, vadd(a.c, a.u, h * 0.80), (0.8 + h * 0.03) * j * sp, h * 0.26, c2, 6, b);
    } else {
      addCone(out, vadd(a.c, a.u, h * 0.28), (3.3 + h * 0.13) * j * sp, h * 0.30, col, 9, b);   // wide skirt
      addCone(out, vadd(a.c, a.u, h * 0.46), (3.7 + h * 0.14) * j * sp, h * 0.26, col, 9, b);   // widest bulge
      addCone(out, vadd(vadd(a.c, a.u, h * 0.66), a.r, lean), (2.9 + h * 0.10) * j * sp, h * 0.26, c2, 8, b);    // shoulder
      addCone(out, vadd(vadd(a.c, a.u, h * 0.82), a.r, lean * 1.6), (1.7 + h * 0.06) * j * sp, h * 0.22, c2, 7, b);    // rounded cap
    }
    reserve();
    out._mat = 0; swayOff();
    return;
  };
  // Palm: tall thin trunk + a crown of drooping frond prisms. nature.js:564-655.
  const placedPalms: Site[] = [];
  const palm = (k: number, side: number, dist: number, h: number, frond?: RVec3 | null): void => {
    let a = anchor(k, side, dist);
    if (onTrack(a.c[0], a.c[2], 4)) {
      ctx.noteSuppressed("palm", `palm SUPPRESSED at k=${k} side=${side}: dist=${dist}`);
      return;
    }
    const frCol: RVec3 = frond || [0.18, 0.40, 0.16];
    const frDark: Vec3 = [frCol[0] * 0.8, frCol[1] * 0.82, frCol[2] * 0.78];
    // Prepare the actual primitives before emission (nature.js:573-575).
    const partsAt = (): { parts: PalmPart[]; base: Vec3 } => {
      const b: Basis = [a.r, a.u, a.t], parts: PalmPart[] = [];
      const lean = (hash(k * 3.3 + side * 2.1 + dist) - 0.5) * 0.5, seg = h / 3;
      const joint = (t: number) => vadd(vadd(a.c, a.u, t * seg), a.r, lean * t * t * 0.4 * side);
      for (let t = 0; t < 3; t++) {
        const p0 = t ? joint(t) : vadd(a.c, a.u, -0.6), p1 = joint(t + 1);
        const d: Vec3 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
        const L = Math.hypot(d[0], d[1], d[2]) || seg, rad = 0.34 - t * 0.06;
        parts.push({ type: "cyl", c: p0, size: [rad * 2, L, rad * 2],
          b: [a.r, [d[0] / L, d[1] / L, d[2] / L], a.t], col: [0.45 - t * 0.03, 0.36, 0.22] });
      }
      const base = joint(3), top = vadd(base, a.u, -0.35);
      parts.push({ type: "box", c: top, size: [1.7, 1.2, 1.7], b, col: frDark });
      for (let i = 0; i < 9; i++) {
        const ang = (i / 9 + hash(k + i * 1.7) * 0.06) * 6.2832, dir = [Math.cos(ang), 0, Math.sin(ang)] as const;
        const fr: Vec3 = [dir[0] * a.r[0] + dir[2] * a.t[0], 0, dir[0] * a.r[2] + dir[2] * a.t[2]];
        const droop = 0.45 + hash(k * 2.1 + i) * 0.5;
        const fu: Vec3 = [fr[0] * droop + a.u[0] * (1 - droop), a.u[1] * (1 - droop * 0.7), fr[2] * droop + a.u[2] * (1 - droop)];
        const len = 5.0 + hash(k + i * 3.3) * 2.0;
        parts.push({ type: "prism", c: vadd(vadd(top, fr, 2.4), a.u, 0.15),
          size: [1.9, 0.5, len], b: [fr, fu, [-fr[2], 0, fr[0]]], col: i % 2 ? frCol : frDark });
      }
      for (let i = 0; i < 3; i++) {
        const ang = i / 3 * 6.2832;
        parts.push({ type: "box", c: vadd(vadd(top, a.r, Math.cos(ang) * 0.5), a.t, Math.sin(ang) * 0.5),
          size: [0.34, 0.34, 0.34], b, col: [0.32, 0.24, 0.14] });
      }
      return { parts, base };
    };
    const footprintsClear = (parts: PalmPart[], barriers: boolean) => parts.every((part) => {
      const f = palmFootprint(part);
      return !ctx.massBlocked(f.c, f.w, f.d, f.b, 1) &&
        !placedPalms.some((p) => (barriers || p.relocated) && palmBoundsOverlap(f, p) &&
          p.parts.some((q) => palmOverlaps(f, q))) &&
        (!barriers || ctx.barrierClear(f.c[0], f.c[2], Math.hypot(f.w, f.d) / 2));
    });
    const foliageClear = (parts: PalmPart[]) => parts.slice(3).every((part) => palmVertices(part).every((v) => {
      const ground = Tracks && typeof Tracks.terrainY === "function"
        ? Tracks.terrainY(track, v[0], v[2]) : terrainYAt(v[0], v[2]);
      return Number.isFinite(ground) && v[1] >= ground!;
    }));
    let assembly = partsAt();
    const initialDist = dist;
    if (!footprintsClear(assembly.parts, false)) {
      let clear = false;
      for (let extra = 1.5; extra <= 12; extra += 1.5) {
        dist = initialDist + extra;
        a = anchor(k, side, dist);
        if (onTrack(a.c[0], a.c[2], 4)) continue;
        assembly = partsAt();
        // Relocations yield to all prior palms and steep ground. Authored
        // groves keep their overlap, except where a relocated tree now stands.
        if (!footprintsClear(assembly.parts, true) || !foliageClear(assembly.parts)) continue;
        clear = true;
        break;
      }
      if (!clear) {
        ctx.noteSuppressed("palm", `palm SUPPRESSED by occupied ground at k=${k} side=${side}: dist=${initialDist}`);
        return;
      }
    }
    ctx.note("palm", [a.c[0], a.c[1] + h / 2, a.c[2]], [h * 0.6, h, h * 0.6], { k, side, dist, initialDist });
    const base = assembly.base;
    const hb = (base[0] - a.c[0]) * a.u[0] + (base[1] - a.c[1]) * a.u[1] + (base[2] - a.c[2]) * a.u[2];
    assembly.parts.forEach((part, i) => {
      if (i === 3) swayOn(a.c, a.u, hb - 1.2, hb + 0.8);
      if (i === 13) swayOff();
      out._mat = i >= 3 && i < 13 ? MAT.FOLIAGE : MAT.WOOD;
      if (part.type === "cyl") addCyl(out, part.c, part.size[0] / 2, part.size[1], part.col!, 6, part.b);
      else if (part.type === "prism") addPrism(out, part.c, part.size, part.col!, part.b);
      else addBox(out, part.c, part.size, part.col!, part.b);
    });
    const footprints = assembly.parts.map(palmFootprint);
    const minX = Math.min(...footprints.map((f) => f.c[0] - f.ex)), maxX = Math.max(...footprints.map((f) => f.c[0] + f.ex));
    const minZ = Math.min(...footprints.map((f) => f.c[2] - f.ez)), maxZ = Math.max(...footprints.map((f) => f.c[2] + f.ez));
    placedPalms.push({ parts: footprints, relocated: dist !== initialDist,
      c: [(minX + maxX) / 2, 0, (minZ + maxZ) / 2], ex: (maxX - minX) / 2, ez: (maxZ - minZ) / 2,
      minY: Math.min(...footprints.map((f) => f.minY)), maxY: Math.max(...footprints.map((f) => f.maxY)) });
    out._mat = 0;
  };
  // nature.js:656-671.
  const conifer = (k: number, side: number, dist: number, h: number, col: RVec3): void => {
    const a = anchor(k, side, dist), b: Basis = [a.r, a.u, a.t];
    if (onTrack(a.c[0], a.c[2], 3)) return;
    const c2: Vec3 = [col[0] * 0.86, col[1] * 0.92, col[2] * 0.82];
    const vr = hash(k * 6.7 + side * 2.3 + dist), j = 0.85 + hash(k * 3.1 + side * 1.7 + dist) * 0.3;
    const lean = vr > 0.6 ? (vr - 0.6) * 1.3 * side : 0;
    out._mat = MAT.WOOD;
    if (addCyl(out, vadd(a.c, a.u, -0.5), 0.3, h * 0.20 + 0.5, [0.34, 0.24, 0.15], 5, b) === false) { out._mat = 0; return; }   // no trunk, no crown (the pit complex keeps footings out)
    out._mat = MAT.FOLIAGE;
    swayOn(a.c, a.u, h * 0.20, h * 1.1);
    addCone(out, vadd(vadd(a.c, a.u, h * 0.14), a.r, lean * 0.14), (2.1 + h * 0.06) * j, h * 0.44, col, 7, b);
    addCone(out, vadd(vadd(a.c, a.u, h * 0.42), a.r, lean * 0.42), (1.6 + h * 0.05) * j, h * 0.38, col, 6, b);
    addCone(out, vadd(vadd(a.c, a.u, h * 0.70), a.r, lean * 0.70), (1.0 + h * 0.04) * j, h * 0.34, c2, 6, b);
    addCone(out, vadd(vadd(a.c, a.u, h * 0.88), a.r, lean * 0.88), (0.6 + h * 0.03) * j, h * 0.28, c2, 5, b);
    out._mat = 0; swayOff();
  };

  // nature.js:673-693.
  const cypress = (k: number, side: number, dist: number, h: number, col: RVec3, opts?: CypressOpts | null): void => {
    opts = opts || {};
    const a = anchor(k, side, dist), b: Basis = [a.r, a.u, a.t];
    const slim = opts.slim != null ? Math.max(0.4, Math.min(2.2, opts.slim)) : 1;
    if (onTrack(a.c[0], a.c[2], 1.6 * slim + 0.6)) {
      ctx.noteSuppressed("cypress", `cypress SUPPRESSED at k=${k} side=${side}: dist=${dist}`);
      return;
    }
    ctx.note("cypress", [a.c[0], a.c[1] + h / 2, a.c[2]], [3 * slim, h, 3 * slim], { k, side });
    // Per-instance tone shift: an avenue of one flat green reads as a fence.
    const dark = hash(k * 7.3 + side * 2.1 + dist) < 0.5;
    const c: RVec3 = dark ? [col[0] * 0.78, col[1] * 0.82, col[2] * 0.80] : col;
    out._mat = MAT.WOOD;
    addCyl(out, vadd(a.c, a.u, -0.4), 0.22, h * 0.18 + 0.4, opts.trunkCol || [0.30, 0.22, 0.14], 5, b);
    out._mat = MAT.FOLIAGE;
    swayOn(a.c, a.u, h * 0.15, h * 1.0);
    addCone(out, vadd(a.c, a.u, h * 0.10), 1.45 * slim, h * 0.58, c, 6, b);
    addCone(out, vadd(a.c, a.u, h * 0.44), 1.10 * slim, h * 0.42, c, 6, b);
    addCone(out, vadd(a.c, a.u, h * 0.70), 0.70 * slim, h * 0.32, c, 6, b);   // pointed crown
    out._mat = 0; swayOff();
  };

  // nature.js:695-717.
  const stonePine = (k: number, side: number, dist: number, h: number, col: RVec3, opts?: StonePineOpts | null): void => {
    opts = opts || {};
    const a = anchor(k, side, dist), b: Basis = [a.r, a.u, a.t];
    const spread = opts.spread != null ? Math.max(0.5, Math.min(1.8, opts.spread)) : 1;
    if (onTrack(a.c[0], a.c[2], h * 0.44 * spread + 0.6)) {
      ctx.noteSuppressed("stonePine", `stonePine SUPPRESSED at k=${k} side=${side}: dist=${dist}`);
      return;
    }
    ctx.note("stonePine", [a.c[0], a.c[1] + h * 0.7, a.c[2]],
             [h * 0.9 * spread, h, h * 0.9 * spread], { k, side });
    const amt = opts.lean != null ? Math.max(0, Math.min(1.5, opts.lean)) : 1;
    const lean = (hash(k * 13.1 + side * 3.7 + dist) - 0.5) * 0.9 * amt;
    const foot = vadd(a.c, a.r, lean * 0.6);
    out._mat = MAT.WOOD;
    addCyl(out, vadd(foot, a.u, -0.5), 0.20 + h * 0.014, h * 0.66 + 0.5,
           opts.trunkCol || [0.40, 0.31, 0.23], 5, b);
    out._mat = MAT.FOLIAGE;
    swayOn(foot, a.u, h * 0.58, h * 1.0);
    const crown = vadd(vadd(foot, a.u, h * 0.60), a.r, lean);
    addFrustum(out, crown, h * 0.12 * spread, h * 0.44 * spread, h * 0.16, col, 7, b);   // flared underside
    addCone(out, vadd(crown, a.u, h * 0.16), h * 0.44 * spread, h * 0.22, col, 7, b);    // shallow dome
    out._mat = 0; swayOff();
  };

  // nature.js:719-746.
  const broadleafFall = (k: number, side: number, dist: number, h: number, col: RVec3, opts?: BroadleafFallOpts | null): void => {
    opts = opts || {};
    const a = anchor(k, side, dist), b: Basis = [a.r, a.u, a.t];
    const spread = opts.spread != null ? Math.max(0.5, Math.min(1.8, opts.spread)) : 1;
    if (onTrack(a.c[0], a.c[2], h * 0.50 * spread + 0.8)) {
      ctx.noteSuppressed("broadleafFall", `broadleafFall SUPPRESSED at k=${k} side=${side}: dist=${dist}`);
      return;
    }
    ctx.note("broadleafFall", [a.c[0], a.c[1] + h * 0.6, a.c[2]],
             [h * 1.0 * spread, h, h * 1.0 * spread], { k, side });
    const lobes = Math.max(2, Math.min(5, Math.round(opts.lobes || 3)));
    out._mat = MAT.WOOD;
    if (addCyl(out, vadd(a.c, a.u, -0.5), 0.22 + h * 0.012, h * 0.42 + 0.5,
           opts.barkCol || [0.36, 0.30, 0.24], 5, b) === false) { out._mat = 0; return; }   // no trunk, no crown
    out._mat = MAT.FOLIAGE;
    swayOn(a.c, a.u, h * 0.40, h * 1.05);
    // Shade the lower lobes: a single flat autumn colour flattens into a blob.
    const c2: Vec3 = [col[0] * 0.82, col[1] * 0.80, col[2] * 0.76];
    for (let i = 0; i < lobes; i++) {
      const ang = i * (6.2832 / lobes) + hash(k + i * 1.9 + side) * 1.2, rr = h * 0.16 * spread;
      const p = vadd(vadd(vadd(a.c, a.u, h * (0.40 + i * 0.09)),
                          a.r, Math.cos(ang) * rr), a.t, Math.sin(ang) * rr);
      addFrustum(out, p, h * (0.30 - i * 0.05) * spread, h * (0.34 - i * 0.08) * spread,
                 h * 0.26, i ? c2 : col, 6, b);
    }
    addCone(out, vadd(a.c, a.u, h * 0.76), h * 0.24 * spread, h * 0.30, col, 6, b);
    out._mat = 0; swayOff();
  };

  // nature.js:748-800.
  const acacia = (k: number, side: number, dist: number, h: number, col: RVec3, opts?: AcaciaOpts | null): void => {
    opts = opts || {};
    const a = anchor(k, side, dist), b: Basis = [a.r, a.u, a.t];
    const spread = opts.spread != null ? Math.max(2, opts.spread) : h * 1.15;
    if (onTrack(a.c[0], a.c[2], spread * 0.5 + 0.8)) {
      ctx.noteSuppressed("acacia", `acacia SUPPRESSED at k=${k} side=${side}: dist=${dist}`);
      return;
    }
    ctx.note("acacia", [a.c[0], a.c[1] + h * 0.8, a.c[2]], [spread, h, spread], { k, side });
    const bark = opts.barkCol || [0.34, 0.26, 0.18];
    const layers = Math.max(1, Math.min(3, Math.round(opts.layers || 2)));
    const c2: Vec3 = [col[0] * 0.82, col[1] * 0.86, col[2] * 0.80];
    // ONE CONNECTED STACK: trunk -> fork -> slab 0 -> slab 1 …, each part
    // starting where the one below ends; parts grow DOWN across a real gap
    // (> JOINT) only (nature.js:760-779).
    const layerY = (i: number) => h * 0.80 + i * Math.min(h * 0.14, 1.0);
    const thick = (i: number) => i === 0 ? Math.max(0.9, 2 * (h * 0.12 - 0.90)) : 0.9 - i * 0.2;
    const JOINT = 0.14;
    const close = (lo: number, hi: number) => hi - lo <= JOINT ? lo : hi;   // `lo` rises to `hi` only across a real gap
    const forkY = close(h * 0.68 + 0.35, layerY(0) - thick(0) / 2) - 0.35;   // fork top meets slab 0
    const trunkTop = close(h * 0.62, forkY - 0.35);                         // trunk meets the fork
    out._mat = MAT.WOOD;
    if (addCyl(out, vadd(a.c, a.u, -0.5), 0.28, trunkTop + 0.5, bark, 5, b) === false) { out._mat = 0; return; }   // no trunk, no crown (the pit complex keeps footings out)
    for (const dr of [-1, 1])                                    // the low fork
      addBox(out, vadd(vadd(a.c, a.u, forkY), a.r, dr * spread * 0.22),
             [spread * 0.44, 0.7, 0.22], bark, b);
    out._mat = MAT.FOLIAGE;
    swayOn(a.c, a.u, trunkTop, h * 1.1);
    // Flat slabs, not cones: the crown's top and bottom are both near-planar.
    for (let i = 0; i < layers; i++) {
      const f = 1 - i * 0.4;
      const top = layerY(i) + thick(i) / 2;
      const bot0 = layerY(i) - thick(i) / 2, below = i ? layerY(i - 1) + thick(i - 1) / 2 : bot0;
      const bot = bot0 - below <= JOINT ? bot0 : below - 0.02;
      addBox(out, vadd(a.c, a.u, (top + bot) / 2),
             [spread * f, top - bot, spread * f], i % 2 ? c2 : col, b);
    }
    out._mat = 0; swayOff();
  };

  // nature.js:802-831.
  const plane = (k: number, side: number, dist: number, h: number, col: RVec3, opts?: PlaneOpts | null): void => {
    opts = opts || {};
    const a = anchor(k, side, dist), b: Basis = [a.r, a.u, a.t];
    const spread = opts.spread != null ? Math.max(0.5, Math.min(1.8, opts.spread)) : 1;
    const rad = (4.2 + h * 0.12) * spread;
    if (onTrack(a.c[0], a.c[2], rad + 0.6)) {
      ctx.noteSuppressed("plane", `plane SUPPRESSED at k=${k} side=${side}: dist=${dist}`);
      return;
    }
    ctx.note("plane", [a.c[0], a.c[1] + h * 0.6, a.c[2]], [rad * 2, h, rad * 2], { k, side });
    const stages = Math.max(1, Math.min(3, Math.round(opts.stages || 2)));
    const c2: Vec3 = [col[0] * 0.80, col[1] * 0.84, col[2] * 0.80];
    out._mat = MAT.WOOD;
    if (addCyl(out, vadd(a.c, a.u, -0.5), 0.42, h * 0.48 + 0.5,
           opts.trunkCol || [0.72, 0.70, 0.62], 6, b) === false) { out._mat = 0; return; }   // no trunk, no crown
    out._mat = MAT.FOLIAGE;
    swayOn(a.c, a.u, h * 0.46, h * 1.1);
    // Each stage starts just inside the one below (nature.js:819-822).
    let base = 0;
    for (let i = 0; i < stages; i++) {
      const sh = h * (0.34 - i * 0.10);
      const y = i < 2 ? h * (0.46 + i * 0.28) : base - h * 0.01 + sh / 2;
      addCyl(out, vadd(a.c, a.u, y), rad * (1 - i * 0.28), sh, i ? c2 : col, 7, b);
      base = y + sh / 2;
    }
    out._mat = 0; swayOff();
  };

  // Landforms must clear the road's whole built width (runoff apron + kerbs),
  // not just the tarmac half-width onTrack() measures (nature.js:836-842).
  const ROAD_SKIRT = 2.6;
  // Distant mountain peak (world coords): pyramid + foot skirt. nature.js:843-859.
  const peak = (x: number, z: number, baseY: number, w: number, h: number, col: RVec3): void => {
    // The foot pyramid's square base reaches w*0.75*sqrt(2) ~= w*1.061 at its corners.
    if (onTrack(x, z, w * 1.061 + ROAD_SKIRT)) {
      ctx.noteSuppressed("peak", `peak SUPPRESSED at x=${x.toFixed(0)} z=${z.toFixed(0)}: w=${w}`);
      return;
    }
    ctx.note("peak", [x, baseY + h / 2, z], [w, h, w]);
    out._mat = MAT.ROCK;
    addPyramid(out, [x, baseY, z], [w, h, w], col, null);
    addPyramid(out, [x, baseY - 2, z], [w * 1.5, h * 0.45, w * 1.5], [col[0] * 0.9, col[1] * 0.92, col[2] * 0.9], null);
    const pj = hash(x * 0.17 + z * 0.19), pa = pj * 6.2832, so = w * (0.25 + pj * 0.13);
    addPyramid(out, [x + Math.cos(pa) * so, baseY - 0.6, z + Math.sin(pa) * so],
      [w * 0.6, h * (0.5 + pj * 0.25), w * 0.72], [col[0] * 0.94, col[1] * 0.95, col[2] * 0.96], null);
    out._mat = 0;
  };
  // nature.js:860-878.
  const mountain = (x: number, z: number, baseY: number, w: number, h: number, opts?: MountainOpts | null): void => {
    opts = opts || {};
    const rough = opts.rough != null ? opts.rough : 0.34;
    const reach = (ww: number) =>
      ROAD_SKIRT +
      Math.max(ww * 0.62, ww * 0.5 * (1 + 0.7 * rough) * (1 + 0.35 * rough));
    let fit = w;
    for (let i = 0; i < 6 && onTrack(x, z, reach(fit)); i++) fit *= 0.88;
    if (onTrack(x, z, reach(fit))) {
      ctx.noteSuppressed("mountain", `mountain SUPPRESSED at x=${x.toFixed(0)} z=${z.toFixed(0)}: w=${w}`);
      return;
    }
    if (fit < w) h *= Math.sqrt(fit / w);   // narrower dune, plausible slope
    w = fit;
    ctx.note("mountain", [x, baseY + h / 2, z], [w, h, w]);
    addFrustum(out, [x, baseY - 2, z], w * 0.62, w * 0.42, h * 0.18,
               opts.forest || [0.20, 0.34, 0.20], 9, null);   // skirt
    addMountain(out, [x, baseY, z], w * 0.5, h, opts);
  };
  // ridge(x, z, baseY, ang, len, w, h, col, opts?) — opts.profile ("massif") swaps the default flat-topped
  // prism pair for an elongated, noise-roughened rounded hill (addMountain with stretch = len/w);
  // opts.rough (default 0.22) / opts.crest (default 0.35) shape it. nature.js:879-922.
  const ridge = (x: number, z: number, baseY: number, ang: number, len: number, w: number, h: number, col: RVec3, opts?: RidgeOpts | null): void => {
    const hill = opts && opts.profile;
    // Skip if footprint half-extent reaches tarmac (a rounded hill's noisy foot reaches ~1.3x further).
    if (onTrack(x, z, Math.max(len, w) * 0.5 * (hill ? 1.3 : 1) + ROAD_SKIRT)) {
      ctx.noteSuppressed("ridge", `ridge SUPPRESSED at x=${x.toFixed(0)} z=${z.toFixed(0)}: len=${len} w=${w}`);
      return;
    }
    ctx.note("ridge", [x, baseY + h / 2, z], [w, h, len]);
    const f: Vec3 = [Math.cos(ang), 0, Math.sin(ang)], r: Vec3 = [-f[2], 0, f[0]];
    // BURY the base by SINK and add it back to the height: the ground out
    // there is the floor slab at pyMin - 1 (nature.js:891-904).
    const SINK = 2;
    if (hill) {
      addMountain(out, [x, baseY - SINK, z], w * 0.5, h + SINK, {
        profile: opts.profile, stretch: len / w, right: r, fwd: f, seed: Math.round(x * 0.37 + z * 0.29),
        rough: opts.rough != null ? opts.rough : 0.22, crest: opts.crest != null ? opts.crest : 0.35,
        forest: col, rock: col, snow: col, snowline: 9 });
      return;
    }
    addPrism(out, [x, baseY - SINK, z], [w, h + SINK, len], col, [r, [0, 1, 0], f]);
    const jr = hash(x * 0.13 + z * 0.11 + ang);
    const a2 = ang + (jr - 0.5) * 0.6;
    const f2: Vec3 = [Math.cos(a2), 0, Math.sin(a2)], r2: Vec3 = [-f2[2], 0, f2[0]];
    const off = (0.06 + jr * 0.06) * len, dY = 1.0;
    addPrism(out,
      [x + f[0] * off, baseY - SINK - dY, z + f[2] * off],
      [w * 0.7, h * (0.42 + jr * 0.22) + SINK + dY, len * 0.4],
      col, [r2, [0, 1, 0], f2]);
  };
  // Returns the number of riser slabs that cleared rejBox; grandstandEx
  // refuses a rowless shell (bahrain T1, 2026-09). nature.js:923-975.
  const crowdBank = (k: number, side: number, gap: number, len: number, rise: number, depth: number, riserCol?: RVec3 | null, lift?: number): number => {
    const a = anchor(k, side, gap), b: Basis = [a.r, a.u, a.t];
    const rows = Math.max(3, Math.round(rise / 1.4));
    const perRow = Math.max(6, Math.round(len / 1.15));
    const riser: RVec3 = riserCol || (NIGHT ? [0.10, 0.10, 0.13] : [0.28, 0.26, 0.27]);
    const y0 = lift || 0;
    let placed = 0;
    for (let r = 0; r < rows; r++) {
      const f = (r + 0.5) / rows, up = y0 + f * rise, back = f * depth;
      // dark step riser behind each seating row; guarded (nature.js:936-942).
      out._mat = MAT.CONCRETE;
      const riserC = vadd(vadd(a.c, a.u, up), a.r, side * back);
      if (rejBox(riserC, [1.3, 1.5, len], b)) continue;
      placed++;
      ctx.instance(`crowd-riser|${riser.join(",")}`,
        { o: riserC, r: a.r, u: a.u, t: a.t, s: [1, 1, len] },
        (rec) => { rec.mat(MAT.CONCRETE); rec.box([0, 0, 0], [1.3, 1.5, 1], riser); },
        { kind: "crowdRiser", k, side }, { unguarded: true });
      out._mat = MAT.FABRIC;
      for (let s2 = 0; s2 < perRow; s2++) {
        if (s2 % 10 === 9) continue;                       // aisle / vomitory gap
        const h1 = hash(k * 2.7 + r * 5.3 + s2 * 1.9 + side * 3.1);
        const h2 = hash(k * 1.3 + r * 8.1 + s2 * 4.7 + side * 2.2);
        if (h2 > 0.86) continue;                            // ~14% empty seats
        const along = ((s2 + 0.5) / perRow - 0.5) * len + (h1 - 0.5) * 0.45;
        const c = vadd(vadd(vadd(a.c, a.t, along), a.u, up + 0.55), a.r, side * back);
        let col: RVec3;
        if (NIGHT) {
          col = h1 > 0.955 ? [2.6, 2.4, 2.0]                // phone light / flash (HDR → blooms)
              : h1 > 0.55  ? [0.09, 0.10, 0.13]            // dark bodies
                           : [0.16, 0.16, 0.21];
        } else {
          col = CROWD_DAY[Math.floor(h1 * CROWD_DAY.length) % CROWD_DAY.length]!;
        }
        ctx.instance("crowd-body",
          { o: c, r: a.r, u: a.u, t: a.t, s: [1, 0.72 + h2 * 0.2, 1], col },
          (rec) => { rec.mat(MAT.FABRIC); rec.box([0, 0, 0], [0.55, 1, 0.5], NODE_COLOR); },
          { kind: "crowd", k, side }, { unguarded: true });
      }
    }
    out._mat = 0;
    return placed;
  };
  // nature.js:976-1210.
  const grandstandEx = (s: number, side: number, gap: number, len: number,
                        shell: RVec3 | null | undefined, crowd: RVec3 | null | undefined, opts?: GrandstandOpts | null): void => {
    opts = opts || {};
    const lib: { readonly [family: string]: StandLivery } = STAND_LIVERIES || {};
    let liveryName = opts.livery;
    if (!liveryName && !shell) {
      // def.standSet (js/circuits/<id>.js) names the livery families this
      // venue rotates through; the three permanent-circuit greys otherwise.
      const set = (def && def.standSet) || STAND_SET_DEF;
      if (set && set.length) {
        const kk = ((Math.round(s * n) % n) + n) % n;
        liveryName = set[Math.floor(hash(kk * 2.7 + side * 1.9) * set.length) % set.length];
      }
    }
    const liv = (liveryName && lib[liveryName]) || null;
    shell = shell || (liv && liv.shell) || null;
    crowd = crowd || (liv && liv.crowd) || null;
    const roofKind = opts.roof || "cantilever";
    const roofCol = opts.roofCol || (liv && liv.roof) || [0.86, 0.88, 0.92];
    const fasciaCol = opts.fasciaCol || (liv && liv.fascia) || shell || [0.40, 0.41, 0.46];
    const tiers = Math.max(1, Math.min(3, Math.round(opts.tiers || 1)));
    const shellH = opts.h != null ? Math.max(6, opts.h) : 12;

    const k = ((Math.round(s * n) % n) + n) % n;
    const halfFrac = (len / 2) / track.total;
    recordBarrier(s - halfFrac, s + halfFrac, side, gap);
    ctx.indexSolid(s - halfFrac, s + halfFrac, side, gap, 12.5);
    const r: Vec3 = [track.rx[k]!, track.ry[k]!, track.rz[k]!];
    const t: Vec3 = [track.tx[k]!, track.ty[k]!, track.tz[k]!];
    const u = upOf(track, k);
    const oInner = side * (hw[k]! + gap);
    const ifx = px[k]! + r[0] * oInner, ifz = pz[k]! + r[2] * oInner;
    if (onTrack(ifx, ifz, 0)) {
      ctx.noteSuppressed("grandstand", `grandstand SUPPRESSED at s=${s} side=${side}: gap=${gap} (inner face on track)`);
      return;
    }
    ctx.note("grandstand", [px[k]! + r[0] * oInner, groundYAt(k, gap) + 6, pz[k]! + r[2] * oInner],
             [10, 12, len], { k, side });
    // Per-call MIN_SEP slot (alternate 0 / MIN_SEP), geometry only and only
    // OUTWARD (nature.js:1013-1020).
    gap += (standSeq++ & 1) * TrackGeom.MIN_SEP;
    // Back shell + upper tiers: the single-tier shell sits BEHIND the crowd
    // bank; a multi-tier stand's shell is STEPPED under each built rake
    // (nature.js:1022-1039).
    const SHELL_IN = 6, SHELL_OUT = 12.5, SEP = TrackGeom.MIN_SEP;
    const BANK_AT = 1.5, BANK_RISE = 7, BANK_DEPTH = 4.2, TIER_BACK = 4.6, TIER_LIFT = 7.6;
    const bankRows = Math.max(3, Math.round(BANK_RISE / 1.4));   // crowdBank's own row count
    // Back face of tier i's rake (last riser: row centre + half its 1.3 m
    // depth), and a rake's floor above its anchor (row 0's riser bottom).
    const rakeBack = (i: number) => BANK_AT + TIER_BACK * i + BANK_DEPTH * (bankRows - 0.5) / bankRows + 0.65;
    const rakeFloor = (lift: number) => lift + BANK_RISE * 0.5 / bankRows - 0.75;
    const shellCol: RVec3 = shell || [0.40, 0.41, 0.46];
    const dotU = (p: RVec3) => p[0] * u[0] + p[1] * u[1] + p[2] * u[2];
    // One shell section from lateral a..b (metres past the road edge): full
    // height, or capped at the u-coordinate capU just below a rake.
    const shellSection = (a: number, b: number, capU: number | null): { top: number } | null => {
      if (b - a < 0.3) return null;
      const mid = (a + b) / 2, o = side * (hw[k]! + gap + mid);
      const base: Vec3 = [px[k]! + r[0] * o, groundYAt(k, gap + mid) - 0.8, pz[k]! + r[2] * o];
      if (capU == null) {
        const c: Vec3 = [base[0], base[1] + shellH / 2, base[2]];
        addBox(out, c, [b - a, shellH, len], shellCol, [r, u, t]);
        return { top: c[1] + shellH / 2 };
      }
      const h = Math.min(shellH, capU - dotU(base));
      if (h < 1) return null;
      const c = vadd(base, u, h / 2);
      addBox(out, c, [b - a, h, len], shellCol, [r, u, t]);
      return { top: c[1] + h / 2 };
    };
    const riserTint: Vec3 | null = crowd ? [crowd[0] * 0.4, crowd[1] * 0.4, crowd[2] * 0.4] : null;
    // Seat first: if seating cannot emit, suppress the whole stand rather
    // than ship a rowless shell (nature.js:1067-1071).
    const bankPlaced = crowdBank(k, side, gap + BANK_AT, len - 2, BANK_RISE, BANK_DEPTH, riserTint);
    if (bankPlaced === 0) {
      ctx.noteSuppressed("grandstand",
        `grandstand SUPPRESSED at s=${s} side=${side}: gap=${gap} (no seating rows cleared rejBox)`);
      return;
    }
    const tierLift: number[] = [];
    let prevBack = rakeBack(0), shellFront = SHELL_IN;
    for (let ti = 1; ti < tiers; ti++) {
      const lift = TIER_LIFT * ti, back = TIER_BACK * ti, tl = len - 2 - ti * 4;
      if (tl < 8) break;
      const ca = anchor(k, side, gap + BANK_AT + back);
      const cb: Basis = [ca.r, ca.u, ca.t];
      // Concourse fascia stripe under the deck: 0.5 m deep, its face SEP
      // behind the rake in front, its top 5 cm under the section's.
      const capU = dotU(ca.c) + rakeFloor(lift) - 0.1;
      const bandA = prevBack + SEP, bandO = side * (hw[k]! + gap + bandA + 0.25);
      const bandBase: Vec3 = [px[k]! + r[0] * bandO, 0, pz[k]! + r[2] * bandO];
      const bandC = vadd(bandBase, u, capU - 0.05 - 0.9 - dotU(bandBase));
      if (!rejBox(bandC, [0.5, 1.8, tl], cb)) {
        addBox(out, bandC, [0.5, 1.8, tl], fasciaCol, cb);
        crowdBank(k, side, gap + BANK_AT + back, tl, BANK_RISE, BANK_DEPTH, riserTint, lift);
        // The shell under this rake, capped below its floor, 1.5 SEP behind
        // the stripe's face so the two front faces never share a plane.
        shellSection(Math.max(shellFront, bandA + 1.5 * SEP), Math.min(SHELL_OUT, rakeBack(ti)), capU);
        prevBack = rakeBack(ti);
        shellFront = prevBack + 2.5 * SEP;
        // Only a tier that actually BUILT raises the roof.
        tierLift.push(lift);
      }
    }
    // Full height behind the last rake (the whole shell of a one-tier stand).
    const fullShell = shellSection(shellFront, SHELL_OUT, null);
    const topLift = tierLift.length ? tierLift[tierLift.length - 1]! : 0;
    // Roof slab cantilevered over the crowd, lifted on the up axis
    const a = anchor(k, side, gap + 5);
    const roofY = 13 + topLift;
    const roofC = vadd(a.c, a.u, roofY);
    const roofW = roofKind === "truss" ? 12 : (roofKind === "flat" ? 10 : 12);
    // The rear fascia's lateral span and how far the slab must reach back to
    // sit on it (nature.js:1112-1116).
    let f0 = 5 + roofW / 2 - 4.08, f1 = f0 + 4;
    if (tierLift.length) { f0 = Math.max(f0, shellFront + SEP); f1 = Math.max(f1, f0 + 0.3); }
    const roofExt = Math.max(0, f1 + 0.08 - (5 + roofW / 2));
    const slabC = vadd(roofC, a.r, side * roofExt / 2);
    if (roofKind !== "none") {
      if (roofKind === "truss") {
        addBox(out, slabC, [12 + roofExt, 0.35, len + 2], roofCol, [a.r, a.u, a.t]);
        const bays = Math.max(2, Math.min(14, Math.round(len / 9)));
        for (let i = 0; i < bays; i++) {
          const off = ((i + 0.5) / bays - 0.5) * len;
          addBox(out, vadd(vadd(a.c, a.t, off), a.u, roofY - 0.9), [11.4, 1.1, 0.5], roofCol, [a.r, a.u, a.t]);
        }
      } else {
        // "flat" sits tight over the shell; "cantilever" (default) overhangs.
        const rw = roofKind === "flat" ? 10 : 12;
        addBox(out, slabC, [rw + roofExt, 0.8, len + 2], roofCol, [a.r, a.u, a.t]);
      }
      // Support columns under the roof's outer (trackside) edge. addCyl is
      // BASE-anchored; the foot is extended DOWNWARD to the ground under its
      // own world x/z (nature.js:1134-1153).
      if (opts.pylons) {
        const posts = Math.max(2, Math.min(12, Math.round(len / 14)));
        const H = roofY - 0.5;
        for (let i = 0; i < posts; i++) {
          const off = ((i + 0.5) / posts - 0.5) * len;
          const pc = vadd(vadd(a.c, a.t, off), a.r, -side * 4.6);
          const drop = Math.max(0, pc[1] - groundUnder(pc[0], pc[2])) + 0.3;
          addCyl(out, vadd(pc, a.u, -drop), 0.28, H + drop,
                 fasciaCol, 6, [a.r, a.u, a.t]);
        }
      }
    }
    // Glazed hospitality band tucked under the roof at the back of the top rake.
    if (opts.suites) {
      const sc = anchor(k, side, gap + 7.0);
      const suiteC = vadd(sc.c, sc.u, roofY - 2.6);
      const suiteCol = opts.suiteCol || (NIGHT ? [1.10, 1.02, 0.80] : [0.34, 0.46, 0.58]);
      if (!rejBox(suiteC, [3.2, 3.0, len - 3], [sc.r, sc.u, sc.t]))
        addBox(out, suiteC, [3.2, 3.0, len - 3], suiteCol, [sc.r, sc.u, sc.t]);
    }
    if (opts.endWalls) {
      for (const sgn of [-1, 1]) {
        const base = vadd(a.c, a.t, sgn * (len / 2));
        const drop = Math.max(0, base[1] - groundUnder(base[0], base[2])) + 0.3;
        const h = roofY - 1 + drop;
        const ec = vadd(base, a.u, (roofY - 1) / 2 - drop / 2);
        if (!rejBox(ec, [11, h, 0.5], [a.r, a.u, a.t]))
          addBox(out, ec, [11, h, 0.5], fasciaCol, [a.r, a.u, a.t]);
      }
    }
    // Rear fascia: closes the gap between the back shell's top and the roof
    // underside, solved from the two pieces' ACTUAL world-space tops
    // (nature.js:1184-1198).
    if (roofKind !== "none") {
      const fm = (f0 + f1) / 2, oF = side * (hw[k]! + gap + fm);
      const shellTop = fullShell && f1 <= SHELL_OUT ? fullShell.top : groundYAt(k, gap + fm) - 0.8;
      const roofUnder = roofC[1] - 0.4;
      if (roofUnder > shellTop - 0.1) {
        addBox(out, [px[k]! + r[0] * oF, (shellTop + roofUnder) / 2, pz[k]! + r[2] * oF],
               [f1 - f0, roofUnder - shellTop + 0.2, len], fasciaCol, [r, u, t]);
      }
    }
    if (NIGHT && roofKind !== "none")
      addBox(out, vadd(a.c, a.u, roofY - 0.65), [8.5, 0.28, len - 1], [1.30, 1.12, 0.74], [a.r, a.u, a.t]);
  };
  // nature.js:1211-1212.
  const grandstand = (s: number, side: number, gap: number, len: number, shell?: RVec3 | null, crowd?: RVec3 | null): void =>
    grandstandEx(s, side, gap, len, shell, crowd, null);

  // nature.js:1214-1387.
  const spectatorHill = (s0: number, s1: number, side: number, gap: number, opts?: SpectatorHillOpts | null): void => {
    opts = opts || {};
    // LAYERED BANKS MUST NOT COINCIDE: a deterministic per-call slot moves the
    // frame OUTWARD by MIN_SEP steps and ALONG the road by 2 x MIN_SEP steps,
    // on odd bases (nature.js:1216-1242).
    const slot = hillSeq++ % 5, SEP = TrackGeom.MIN_SEP;
    gap += 0.017 + slot * SEP;
    const sShift = 0.007 + ((slot * 2) % 5) * SEP;
    const rows = Math.max(2, Math.min(8, Math.round(opts.rows || 4)));
    const rise = opts.rise != null ? opts.rise : 1.15;      // per-row height gain
    // `opts.h` is deliberately NOT honoured (nature.js:1248-1255).
    const depth = opts.depth != null ? opts.depth : 2.0;    // per-row setback
    // `col` is the older name some circuits pass for the tread colour
    // (donington, mosport, okayama): honoured when `grass` is absent.
    const grass: RVec3 = opts.grass || opts.col || [0.26, 0.42, 0.20];
    const riser: RVec3 = opts.riser || [0.30, 0.30, 0.28];
    const dens = opts.density != null ? Math.max(0.05, Math.min(1, opts.density)) : 0.65;
    const step = opts.step || 5;
    // The bank is a solid mass — index it so treelines cannot grow through it.
    ctx.indexSolid(s0, s1, side, gap, rows * depth + 1);
    ctx.along(s0, s1, step, (k, spacing) => {
      // ONE terrain sample per along-step; every row is offset from this SAME
      // frame, so rows cannot self-intersect (nature.js:1266-1273).
      const a = anchor(k, side, gap);
      const b: Basis = [a.r, a.u, a.t];
      const ac = vadd(a.c, a.t, sShift);   // layer nudge, along the road
      let previousRow = false;
      for (let r = 0; r < rows; r++) {
        const back = r * depth, up = r * rise;
        // Terrace tread: a wide flat step. Guarded — a bank creeping toward
        // the tarmac must be dropped, not left overhanging the road.
        const tc = vadd(vadd(ac, a.u, up + rise * 0.5), a.r, side * back);
        // Fit each box between the bisectors of its neighbours (nature.js:1283-1287).
        let treadSpan = spacing;
        const nodes = Math.max(1, Math.round(spacing / ds));
        for (const dk of [-nodes, nodes]) {
          const q = anchor((k + dk + n) % n, side, gap);
          const qc = vadd(vadd(vadd(q.c, q.t, sShift), q.u, up + rise * 0.5), q.r, side * back);
          const delta: Vec3 = [qc[0] - tc[0], qc[1] - tc[1], qc[2] - tc[2]];
          const d = Math.hypot(delta[0], delta[1], delta[2]);
          if (!(d > 0)) { treadSpan = 0; break; }
          const proj = (axis: RVec3) => Math.abs((axis[0] * delta[0] + axis[1] * delta[1] + axis[2] * delta[2]) / d);
          const along = proj(a.t);
          const available = d - depth * proj(a.r) - (rise + 0.5) * proj(a.u);
          // Fixed radial/vertical support can fill the separating interval
          // even when its along projection is zero. Such a row cannot fit;
          // otherwise keep the actual positive span, however short it is.
          if (!(available > 0)) { treadSpan = 0; break; }
          if (along > 0) treadSpan = Math.min(treadSpan, available / along);
        }
        if (!(treadSpan > 0) || rejBox(tc, [depth, rise + 0.5, treadSpan], b)) { previousRow = false; continue; }
        // Carry the FRONT row's underside down to the lowest drawn ground
        // beneath it, top unchanged (nature.js:1306-1312).
        let treadC = tc, treadH = rise + 0.5;
        if (r === 0 && a.u[1] > 0.1 && Tracks && typeof Tracks.terrainY === "function") {
          const bot = vadd(tc, a.u, -treadH / 2);
          let drop = 0;
          for (const [x, z] of [[-0.5, -0.5], [-0.5, 0.5], [0.5, -0.5], [0.5, 0.5]] satisfies [number, number][]) {
            const q = vadd(vadd(bot, a.r, x * depth), a.t, z * treadSpan);
            const y = Tracks.terrainY(track, q[0], q[2]);
            if (!Number.isFinite(y)) { drop = NaN; break; }
            drop = Math.max(drop, q[1] - y!);
          }
          if (drop > 0.05) {
            const ext = (drop + 0.05) / a.u[1];
            const c2 = vadd(tc, a.u, -ext / 2);
            if (!rejBox(c2, [depth, treadH + ext, treadSpan], b)) { treadC = c2; treadH += ext; }
          }
        }
        out._mat = MAT.CONCRETE;
        addBox(out, treadC, [depth, treadH, treadSpan], r % 2 ? riser : grass, b);
        // A tight bend can reject the lower rows but retain a narrow upper
        // tread: give that island its own small pier.
        if (r > 0 && !previousRow) {
          const bottom = vadd(treadC, a.u, -treadH / 2);
          const pr = norm([a.r[0], 0, a.r[2]]), pt = norm([a.t[0], 0, a.t[2]]);
          const pb: Basis = [pr, [0, 1, 0], pt];
          const w = Math.min(0.4, depth * 0.5);
          const d = Math.min(0.4, treadSpan * Math.hypot(a.t[0], a.t[2]) * 0.5);
          let footY = Infinity;
          for (const x of [-w / 2, w / 2]) for (const z of [-d / 2, d / 2]) {
            const q = vadd(vadd(bottom, pr, x), pt, z);
            const y = Tracks && typeof Tracks.terrainY === "function"
              ? Tracks.terrainY(track, q[0], q[2]) : terrainYAt(q[0], q[2]);
            if (!Number.isFinite(y)) { footY = NaN; break; }
            footY = Math.min(footY, y!);
          }
          if (Number.isFinite(footY) && bottom[1] > footY + 0.05) {
            const h = bottom[1] + 0.04 - (footY - 0.05);
            const c: Vec3 = [bottom[0], footY - 0.05 + h / 2, bottom[2]];
            if (!rejBox(c, [w, h, d], pb)) ctx.instance("spectator-hill-footing",
              { o: c, r: pr, u: pb[1], t: pt, s: [w, h, d], col: riser },
              (rec) => { rec.mat(MAT.CONCRETE); rec.box([0, 0, 0], [1, 1, 1], NODE_COLOR); },
              { kind: "hill-footing", k, side });
          }
        }
        previousRow = true;
        out._mat = MAT.FABRIC;
        // Preserve the authored count wherever complete 0.5 x 0.46 m bodies
        // fit; the whole footprint, including jitter, stays on its tread.
        const bodyW = 0.5, bodyD = 0.46, edge = 0.03;
        const originalCount = Math.max(2, Math.round(spacing / 1.8));
        const perRow = treadSpan >= bodyD + 2 * edge && depth >= bodyW + 2 * edge
          ? Math.min(originalCount, Math.max(1, Math.floor(treadSpan / 0.6))) : 0;
        const slotSpan = perRow ? treadSpan / perRow : 0;
        const alongJitter = Math.min(0.25, Math.max(0, slotSpan / 2 - bodyD / 2 - edge));
        const backJitter = Math.min(depth / 4, Math.max(0, depth / 2 - bodyW / 2 - edge));
        for (let i = 0; i < perRow; i++) {
          const h1 = hash(k * 3.3 + r * 7.1 + i * 2.3 + side * 1.9);
          if (h1 > dens) continue;
          const h2 = hash(k * 5.9 + r * 2.7 + i * 6.1 + side * 4.3);
          const off = ((i + 0.5) / perRow - 0.5) * treadSpan + (h2 - 0.5) * 2 * alongJitter;
          const c = vadd(vadd(vadd(ac, a.t, off), a.u, up + rise + 0.55),
                         a.r, side * (back + (h2 - 0.5) * 2 * backJitter));
          const col: RVec3 = NIGHT
            ? (h2 > 0.95 ? [2.4, 2.2, 1.9] : [0.12, 0.13, 0.17])
            : (opts.crowd || CROWD_DAY)[Math.floor(h2 * (opts.crowd || CROWD_DAY).length) % (opts.crowd || CROWD_DAY).length]!;
          ctx.instance("crowd-standing",
            { o: c, r: a.r, u: a.u, t: a.t, s: [1, 0.86 + h1 * 0.2, 1], col },
            (rec) => { rec.mat(MAT.FABRIC); rec.box([0, 0, 0], [0.5, 1, 0.46], NODE_COLOR); },
            { kind: "crowd", k, side }, { unguarded: true });
        }
        out._mat = 0;
      }
    });
  };
  // Low clipped hedge / continuous treeline. nature.js:1388-1428.
  const HEDGE_W = 2.4;
  const hedge = (s0: number, s1: number, side: number, gap: number, h: number, col?: RVec3 | null): void => {
    // Index the geometry only (a hedge is not a barrier); yield segment by
    // segment to recorded barriers, decided BEFORE indexSolid registers the
    // hedge's own mass (nature.js:1391-1403).
    const blocked = new Set<number>();
    ctx.along(s0, s1, 4, (k) => {
      const p = anchor(k, side, gap);
      if (!ctx.barrierClear(p.c[0], p.c[2], HEDGE_W / 2)) blocked.add(k);
    });
    ctx.indexSolid(s0, s1, side, gap - HEDGE_W / 2, HEDGE_W);
    ctx.along(s0, s1, 4, (k, spacing) => {
      if (blocked.has(k)) return;
      const p = anchor(k, side, gap);
      // 5 m, not 1.2: a field hedge near ANOTHER stretch of road hung over
      // that road's terrain dip (magny_cours 0.405).
      if (onTrack(p.c[0], p.c[2], 5)) {
        ctx.noteSuppressed("hedge", `hedge SUPPRESSED at k=${k} side=${side}: gap=${gap}`);
        return;
      }
      const base: RVec3 = col || [0.18, 0.36, 0.16], hb: Basis = [p.r, p.u, p.t];
      const hj = h * (0.9 + hash(k * 5.1 + side) * 0.2);
      addBox(out, vadd(p.c, p.u, (hj - 0.4) / 2), [HEDGE_W, hj + 0.4, spacing], base, hb);   // base sunk 0.4
      const lump = 0.25 + hash(k * 7.7 + side) * 0.5, lx = (hash(k * 3.3 + side) - 0.5) * HEDGE_W * 0.4;
      addBox(out, vadd(vadd(vadd(p.c, p.u, hj + lump * 0.5 - 0.2), p.r, lx), p.t, (hash(k * 9.1) - 0.5) * spacing * 0.3),
             [HEDGE_W * (0.5 + hash(k * 2.2) * 0.3), lump, spacing * 0.55],
             [base[0] * 0.9, base[1] * 0.92, base[2] * 0.88], hb);
    });
  };
  // Canopy outer radius for a species at height h — the SINGLE source of
  // truth for how far a tree's foliage reaches sideways; forestEdge() and the
  // FURN roadside scatter both derive placement from it. nature.js:1429-1464.
  const canopyR = (kind: string, h: number): number => {
    const jMax = 1.15;                                  // per-instance jitter ceiling
    if (kind === "pine") return 2.7 * jMax + 0.4;       // pine(): widest lower tier
    // fir → conifer(): mesh extent + lean budget, floored at ~90% of
    // broadleaf keep-out (nature.js:1445-1448).
    if (kind === "fir") {
      const mesh = (2.1 + h * 0.06) * jMax + 0.8;
      const broad = (3.7 + h * 0.14) * jMax + 0.4;
      return Math.max(mesh, broad * 0.9);
    }
    if (kind === "palm") return 5.2;                    // frond hub 2.4 + blade spread
    if (kind === "cypress")       return 1.45 * jMax + 0.4;   // narrow column
    if (kind === "stonePine")     return h * 0.44 + 0.6;      // wide flat parasol
    if (kind === "broadleafFall") return h * 0.50 + 0.8;      // lobed crown (lobe radial offset + widest lobe radius)
    if (kind === "acacia")        return h * 0.575 + 0.8;     // flat-topped thorn, spread = h*1.15
    if (kind === "plane")         return 4.2 + h * 0.12 + 0.6;  // pollarded avenue crown
    if (kind === "vase")          return (4.0 + h * 0.17) * jMax + 0.4;
    if (kind === "weeping")       return (3.9 + h * 0.16) * jMax + 0.4;
    if (kind === "columnar")      return (1.5 + h * 0.05) * jMax + 0.4;
    return (3.7 + h * 0.14) * jMax + 0.4;               // tree(): widest bulge cone
  };
  // forestEdge(): a DENSE treeline (mix of pine/tree) from s0→s1 on `side`,
  // deferred to the foliage pass; the canopy's INNER edge stays at least `gap`
  // beyond the road edge. nature.js:1465-1529.
  const deferredFoliage: ForestEdgeArgs[] = [];
  const forestEdge = (...a: ForestEdgeArgs): void => { deferredFoliage.push(a); };
  const forestEdgeNow = (s0: number, s1: number, side: number, gap: number, opts?: ForestEdgeOpts | null): void => {
    opts = opts || {};
    const hMin = opts.hMin != null ? opts.hMin : 7;
    const hMax = opts.hMax != null ? opts.hMax : 13;
    const pineCol = opts.col || [0.16, 0.36, 0.16];
    const treeCol = opts.col2 || [0.20, 0.40, 0.16];
    const pineFrac = opts.pineFrac != null ? opts.pineFrac : 0.55;
    // density 0..1 → step 7m (sparse) … 3m (dense); along() quantises to whole
    // nodes, so only two spacings are reachable (nature.js:1474-1491).
    const dens = opts.density != null ? Math.max(0.05, Math.min(1, opts.density)) : 0.7;
    // `spacing` (METRES between trunks) is the escape hatch from the two
    // reachable density spacings (nature.js:1493-1499).
    const step = opts.spacing != null ? Math.max(ds, opts.spacing) : 7 - dens * 4;
    // opts.crown:"lobed" is shorthand for treeOptions:{crown:"lobed"}; opts.palmFrac (default 0) turns
    // that share of the line into palms (frond colour = opts.palmCol || col2).
    const treeOpts = opts.treeOptions || (opts.crown === "lobed" ? { crown: "lobed" } : null);
    const detailed = treeOpts && treeOpts.crown === "lobed" ? treeOpts : null;
    const palmFrac = opts.palmFrac! > 0 ? Math.min(1, opts.palmFrac!) : 0;
    const palmCol = opts.palmCol || treeCol;
    const limit = detailed && detailed.maxDetailed !== undefined ? detailed.maxDetailed : 30;
    let accepted = 0;
    ctx.along(s0, s1, step, (k) => {
      const s = hash(k * 4.3 + side * 1.1);
      const h = hMin + s * (hMax - hMin);
      const isPalm = palmFrac > 0 && hash(k * 2.3 + side * 3.7) < palmFrac;
      const isPine = !isPalm && hash(k * 6.7 + side * 0.7) < pineFrac;
      const canopy = canopyR(isPalm ? "palm" : isPine ? "pine" : "broad", h);
      // dist so the canopy's inner edge sits `gap` beyond the road edge
      const dist = gap + canopy;
      // stagger a back row slightly for depth on the densest treelines
      const back = (dens > 0.6 && hash(k * 8.9 + side) < 0.4) ? canopy * 1.4 : 0;
      const d = clearTreeDist(k, side, dist + back, canopy);
      if (d == null) return;
      if (isPalm) palm(k, side, d, h, palmCol);
      else if (isPine) pine(k, side, d, h, pineCol);
      else if (detailed && Number.isInteger(limit) && limit > 0 && limit <= 60 && accepted < limit) {
        const result = tree(k, side, d, h, treeCol, detailed);
        if (result === true) accepted++;
        else if (result === false) tree(k, side, d, h, treeCol);
      } else tree(k, side, d, h, treeCol);
    });
  };
  // nature.js:1530-1571.
  const bush = (k: number, side: number, dist: number, col?: RVec3 | null, opts?: BushOpts | null): void => {
    const bform = (opts && opts.form) || "clump";
    const p = anchor(k, side, dist), b: Basis = [p.r, p.u, p.t];
    if (onTrack(p.c[0], p.c[2], 2)) {
      ctx.noteSuppressed("bush", `bush SUPPRESSED at k=${k} side=${side}: dist=${dist}`);
      return;
    }
    // Nominal envelope: the clump's typical extent, not a measured bound.
    ctx.note("bush", [p.c[0], p.c[1] + 1.4, p.c[2]], [3, 2.8, 3], { k, side });
    const bc: RVec3 = col || [0.20, 0.38, 0.18];
    const c2: Vec3 = [bc[0] * 0.90, bc[1] * 0.94, bc[2] * 0.88];
    const jh = hash(k * 4.3 + side * 2.1 + dist);
    let lobes = (opts && opts.lobes) || (jh < 0.4 ? 2 : 3);   // most clumps 2-3 lobes
    // Understorey is foliage too: inheriting FLAT from the caller makes
    // clumps shade as solid props and misclassifies natural crown overlap.
    const previousMat = out._mat;
    out._mat = MAT.FOLIAGE;
    if (bform === "agave") {
      // Spiky rosette — desert circuits need something that is not a blob.
      for (let i = 0; i < 6; i++) {
        const ang = i / 6 * 6.2832;
        const tip = vadd(vadd(vadd(p.c, p.u, 1.5), p.r, Math.cos(ang) * 1.3), p.t, Math.sin(ang) * 1.3);
        addCone(out, vadd(p.c, p.u, 0.2), 0.34, 1.9, bc, 4,
          [p.r, norm([tip[0] - p.c[0], 1.3, tip[2] - p.c[2]]), p.t]);
      }
      out._mat = previousMat;
      return;
    }
    if (bform === "grass") { lobes = 1; }   // a single low tussock
    for (let i = 0; i < lobes; i++) {
      const lh = hash(k * 5.9 + side * 3.3 + dist + i * 1.7);
      const ang = (i / lobes + lh * 0.3) * 6.2832;
      const off = lobes > 1 ? 0.6 + lh * 0.5 : 0;
      const lx = Math.cos(ang) * off, lz = Math.sin(ang) * off;
      const lc = vadd(vadd(p.c, p.r, lx), p.t, lz);
      const rad = (1.1 + lh * 0.9) * (lobes > 1 ? 0.82 : 1.15);
      addCone(out, vadd(lc, p.u, -0.3 + lh * 0.1), rad, 2.2 + lh * 1.0, i === 0 ? bc : c2, 6, b);
    }
    out._mat = previousMat;
  };

  return { anchor, groundUnder, pine, tree, palm, conifer,
           cypress, stonePine, broadleafFall, acacia, plane,
           peak, mountain, ridge,
           crowdBank, grandstand, grandstandEx, spectatorHill, bush, hedge, forestEdge,
           canopyR, forestEdgeNow, deferredFoliage, treeInFootprint };
}
