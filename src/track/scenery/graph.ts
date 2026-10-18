/**
 * TrackGraph: the scenery MODEL LIBRARY + NODE GRAPH. A model is a recorded
 * list of primitive ops in canonical space; each placement (a node) replays
 * them into the world through the guarded emitters, and `batches()` reports
 * which placements an instanced renderer could draw from one canonical mesh.
 *
 * Port of f1-game js/track/scenery/graph.js:1-480 (`TrackGraph`). The f1-game
 * module takes its raw emitters as `ctx.raw` and reads no engine global, so
 * this port needs no `SceneryCore`.
 */
import type { Basis, RVec3, SceneryBuffer } from "../../contracts/scenery";
import type { BakedMesh } from "./core";

const __M = Math, __isFinite = Number.isFinite;

/** graph.js:7-8: unrolled; every() paid an iterator per call at ~100k calls/build. */
const isVec3 = (v: unknown): v is RVec3 => Array.isArray(v) && v.length === 3 &&
  __isFinite(v[0]) && __isFinite(v[1]) && __isFinite(v[2]);

/** graph.js:10: an op coloured by its placement (`place.col`, else white). */
export const NODE_COLOR = "@node";
export type NodeColor = typeof NODE_COLOR;
/** An op colour: RGB, or NODE_COLOR to take the placement's colour. */
export type GraphColor = RVec3 | NodeColor;

const WHITE: RVec3 = [1, 1, 1];
const colourOf = (op: GraphOp, place: GraphPlace): RVec3 =>
  op.col === NODE_COLOR ? (place.col || WHITE) : op.col;

/** Per-vertex material callback (`out._matAt`), js/track/core/geom.js. */
export type MatAt = (x: number, y: number, z: number) => number;

/** Canonical-space [y0, y1] heights of a wind-swaying crown. */
export type SwayRange = readonly [number, number];

/**
 * The accumulator the graph replays into: a scenery buffer plus the per-op
 * registers build-props.js's guarded emitters read (graph.js:159-288,
 * build-props.js:472-549).
 */
export interface GraphOut extends SceneryBuffer {
  _matAt?: MatAt | null;
  _pitRejected?: boolean;
  _dryRun?: boolean;
  _absorbOnly?: boolean;
  _preferInstance?: boolean;
  _recVerdicts?: Uint8Array | null;
  _replayVerdicts?: Uint8Array | null;
  _vIdx?: number;
}

/** bakeCanonical's plain-array buffer (graph.js:93). */
export interface CanonicalGeo extends GraphOut {
  readonly pos: number[];
  readonly nrm: number[];
  readonly col: number[];
  readonly idx: number[];
  readonly mat: number[];
}

/**
 * The emitter set `replay` drives: build-props.js GUARDED/UNGUARDED (return
 * false when a primitive is dropped) or the raw TrackGeom emitters (which
 * return nothing). `roundNormals` is present only on crown recipes
 * (build-props.js:574-577).
 */
export interface GraphEmitters {
  addBox(o: GraphOut, c: RVec3, sz: RVec3, col: RVec3, basis: Basis | null): boolean | void;
  addPrism(o: GraphOut, c: RVec3, sz: RVec3, col: RVec3, basis: Basis | null): boolean | void;
  addPyramid(o: GraphOut, c: RVec3, sz: RVec3, col: RVec3, basis: Basis | null): boolean | void;
  addCyl(o: GraphOut, c: RVec3, rad: number, h: number, col: RVec3, seg: number | undefined, basis: Basis | null): boolean | void;
  addCone(o: GraphOut, c: RVec3, rad: number, h: number, col: RVec3, seg: number | undefined, basis: Basis | null): boolean | void;
  addFrustum(
    o: GraphOut, c: RVec3, rB: number, rT: number, h: number, col: RVec3, seg: number | undefined, basis: Basis | null,
  ): boolean | void;
  roundNormals?(o: GraphOut, v0: number, base: RVec3, up: RVec3): void;
}

/** graph.js:52-55: `TrackGraph.create({ raw })` (build-props.js:550). */
export interface GraphCtx {
  readonly raw?: GraphEmitters | null;
}

interface OpBase {
  readonly c: RVec3;
  readonly col: GraphColor;
  /** undefined = inherit whatever out._mat holds at replay time (graph.js:68-70). */
  mat?: number | undefined;
  sway?: SwayRange;
}
export interface SizedOp extends OpBase { readonly op: "box" | "prism" | "pyramid"; readonly sz: RVec3 }
export interface RadialOp extends OpBase {
  readonly op: "cyl" | "cone";
  readonly rad: number;
  readonly h: number;
  readonly seg: number | undefined;
}
export interface FrustumOp extends OpBase {
  readonly op: "frustum";
  readonly rB: number;
  readonly rT: number;
  readonly h: number;
  readonly seg: number | undefined;
}
/** One recorded primitive (graph.js:79-84). */
export type GraphOp = SizedOp | RadialOp | FrustumOp;

/** The `rec` a model's build callback records into (graph.js:73-85). */
export interface Recorder {
  mat(id?: number | null, swayRange?: SwayRange | null): void;
  box(c: RVec3, sz: RVec3, col: GraphColor): boolean;
  prism(c: RVec3, sz: RVec3, col: GraphColor): boolean;
  pyramid(c: RVec3, sz: RVec3, col: GraphColor): boolean;
  cyl(c: RVec3, rad: number, h: number, col: GraphColor, seg?: number): boolean;
  cone(c: RVec3, rad: number, h: number, col: GraphColor, seg?: number): boolean;
  frustum(c: RVec3, rB: number, rT: number, h: number, col: GraphColor, seg?: number): boolean;
}
export type ModelBuild = (rec: Recorder) => void;

export interface Aabb {
  readonly mn: [number, number, number];
  readonly mx: [number, number, number];
}

/** A model record (graph.js:146-153); `_whole`/`_verd` are per-model verdict scratch (graph.js:223, :243). */
export interface GraphModel {
  readonly key: string;
  readonly ops: GraphOp[];
  uses: number;
  readonly hasRadial: boolean;
  readonly nodeColored: boolean;
  readonly geo: CanonicalGeo | null;
  readonly aabb: Aabb;
  readonly verts: number;
  _whole?: Uint8Array;
  _verd?: Uint8Array;
}

/** A placement: world = o + [r,u,t] * (local * s) (graph.js:16-31). */
export interface GraphPlace {
  readonly o: RVec3;
  readonly r: RVec3;
  readonly u: RVec3;
  readonly t: RVec3;
  readonly s?: RVec3 | null;
  readonly col?: RVec3 | null;
}

/** instance() metadata: `kind` keys stats; `whole` asks all-or-nothing (graph.js:218-222). */
export interface GraphMeta {
  readonly kind?: string;
  readonly whole?: boolean;
  readonly [key: string]: unknown;
}

/** A landed placement (graph.js:262-276). */
export interface GraphNode extends GraphPlace {
  readonly model: string;
  readonly s: RVec3 | null;
  readonly col: RVec3 | null;
  readonly landed: number;
  readonly full: boolean;
  readonly inst: boolean;
  readonly meta: GraphMeta | null;
}

/** A compacted pack mesh (graph.js:326). */
export interface MeshGeo {
  readonly pos: Float32Array;
  readonly nrm: Float32Array;
  readonly col: Float32Array;
  readonly mat: Float32Array;
  readonly idx: Uint32Array;
}
export interface MeshPlace {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly s: number;
  readonly tint: RVec3 | null;
}
/** A registered baked mesh (graph.js:62-63, :326). */
export interface MeshRecord {
  readonly key: string;
  readonly geo: MeshGeo;
  readonly verts: number;
  readonly tris: number;
  readonly places: MeshPlace[];
  tinted: boolean;
}

/** One instanced batch (graph.js:368, :425). */
export interface GraphBatch {
  readonly model: string;
  readonly geo: CanonicalGeo | MeshGeo | null;
  readonly verts: number;
  readonly count: number;
  readonly matrices: Float32Array;
  readonly colors: Float32Array | null;
}

export interface KindStats {
  nodes: number;
  models: number;
  fusedVerts: number;
  uniqueVerts: number;
  reuse: number;
}

export interface GraphStats {
  readonly models: number;
  readonly nodes: number;
  readonly dropped: number;
  readonly mesh: { readonly models: number; readonly instances: number; readonly uniqueVerts: number; readonly fusedVerts: number };
  readonly uniqueVerts: number;
  readonly fusedVerts: number;
  readonly reuse: number;
  readonly byKind: Record<string, KindStats>;
}

/** graph.js:475. */
export interface GraphApi {
  readonly models: Map<string, GraphModel>;
  readonly nodes: GraphNode[];
  readonly meshes: Map<string, MeshRecord>;
  model(key: string, build: ModelBuild): GraphModel;
  instance(
    key: string, place: GraphPlace | null | undefined, build: ModelBuild,
    meta: GraphMeta | null | undefined, emit: GraphEmitters | null | undefined, out: GraphOut,
  ): number;
  replay(m: GraphModel, place: GraphPlace, emit: GraphEmitters, out: GraphOut): number;
  bake(emit: GraphEmitters, out: GraphOut): number;
  batches(opts?: { readonly instancedOnly?: boolean } | null): { batches: GraphBatch[]; bakeOnly: GraphNode[] };
  stats(): GraphStats;
  meshModel(key: string, mesh: BakedMesh, mat?: number | null): MeshRecord;
  meshPlace(key: string, x: number, y: number, z: number, yaw: number, scale?: number | null, tint?: RVec3 | null): boolean;
}

// world = o + R * (local * scale), R the column basis [r,u,t].
// Pooled output: replay consumes each result synchronously before the next op
// (the one retention risk, badPrimitive's diagnostics center, copies) — a
// fresh triple per op was ~340k arrays per build across the two replays.
const _xfOut: [number, number, number] = [0, 0, 0];
/** graph.js:20-31. */
export function xform(place: GraphPlace, lc: RVec3): RVec3 {
  const s = place.s;
  const x = s ? lc[0] * s[0] : lc[0];
  const y = s ? lc[1] * s[1] : lc[1];
  const z = s ? lc[2] * s[2] : lc[2];
  const r = place.r, u = place.u, t = place.t, o = place.o;
  _xfOut[0] = o[0] + r[0] * x + u[0] * y + t[0] * z;
  _xfOut[1] = o[1] + r[1] * x + u[1] * y + t[1] * z;
  _xfOut[2] = o[2] + r[2] * x + u[2] * y + t[2] * z;
  return _xfOut;
}

// graph.js:33-37: radial ops take the larger XZ scale so the guard footprint is
// never UNDER-estimated (an under-estimate would let a prop reach tarmac).
const radScale = (s: RVec3 | null | undefined) => (s ? __M.max(__M.abs(s[0]), __M.abs(s[2])) : 1);
const upScale = (s: RVec3 | null | undefined) => (s ? __M.abs(s[1]) : 1);
/** graph.js:38-40: mirrors TrackGeom.SWAY_FRAC (f1-game track-graph.test.mjs pins them equal). */
export const SWAY_FRAC = 0.45;
// graph.js:41-49: per-vertex material callback for a swaying op: base/up/scale
// place the canonical [y0, y1] range in the space the vertices are emitted in.
function swayAt(id: number, base: RVec3, up: RVec3, us: number, range: SwayRange): MatAt {
  const y0 = range[0] * us, inv = 1 / __M.max(1e-6, (range[1] - range[0]) * us);
  return (x, y, z) => {
    const w = ((x - base[0]) * up[0] + (y - base[1]) * up[1] + (z - base[2]) * up[2] - y0) * inv;
    return id + (w <= 0 ? 0 : w >= 1 ? 1 : w) * SWAY_FRAC;
  };
}
const _ORIGIN: RVec3 = [0, 0, 0], _UP: RVec3 = [0, 1, 0];

/** graph.js:52-476. */
export function create(ctx?: GraphCtx | null): GraphApi {
  ctx = ctx || {};
  const raw = ctx.raw || null;

  const models = new Map<string, GraphModel>();   // key -> { key, ops, geo, verts, aabb }
  const nodes: GraphNode[] = [];
  let dropped = 0;
  // graph.js:57-63: BAKED-MESH placements — one compacted geometry per key plus
  // [x, y, z, yaw, scale] records; batches() turns them into one instanced batch per key.
  const meshes = new Map<string, MeshRecord>();   // key -> { key, geo, verts, tris, places: [], tinted }

  // graph.js:67-86.
  function recorder(ops: GraphOp[]): Recorder {
    // undefined = "inherit whatever out._mat holds at replay time". out._mat is
    // a persistent register, so a helper that never sets it (marshalPost) must
    // keep inheriting; forcing 0 here would silently untexture those props.
    let mat: number | undefined, sway: SwayRange | null | undefined;
    const push = (op: GraphOp) => { op.mat = mat; if (sway) op.sway = sway; ops.push(op); return true; };
    return {
      // out._mat equivalent — stamps every op recorded after it. `sway`
      // ([y0, y1], canonical-space heights) marks the ops after it as a wind-
      // swaying crown (graph.js:74-78).
      mat(id, swayRange) { mat = id || 0; sway = swayRange || null; },
      box: (c, sz, col) => push({ op: "box", c, sz, col }),
      prism: (c, sz, col) => push({ op: "prism", c, sz, col }),
      pyramid: (c, sz, col) => push({ op: "pyramid", c, sz, col }),
      cyl: (c, rad, h, col, seg) => push({ op: "cyl", c, rad, h, col, seg }),
      cone: (c, rad, h, col, seg) => push({ op: "cone", c, rad, h, col, seg }),
      frustum: (c, rB, rT, h, col, seg) => push({ op: "frustum", c, rB, rT, h, col, seg }),
    };
  }

  // graph.js:88-113: the buffer an instanced renderer uploads ONCE per model,
  // and how the model's vertex cost and AABB are measured.
  function bakeCanonical(ops: readonly GraphOp[]): CanonicalGeo | null {
    if (!raw) return null;
    const buf: CanonicalGeo = { pos: [], nrm: [], col: [], idx: [], mat: [], _mat: 0, _matAt: null };
    for (const op of ops) {
      buf._mat = op.mat || 0;
      buf._matAt = op.sway ? swayAt(buf._mat, _ORIGIN, _UP, 1, op.sway) : null;
      const col = op.col === NODE_COLOR ? WHITE : op.col;
      const v0 = buf.pos.length / 3;
      switch (op.op) {
        case "box": raw.addBox(buf, op.c, op.sz, col, null); break;
        case "prism": raw.addPrism(buf, op.c, op.sz, col, null); break;
        case "pyramid": raw.addPyramid(buf, op.c, op.sz, col, null); break;
        case "cyl": raw.addCyl(buf, op.c, op.rad, op.h, col, op.seg, null); break;
        case "cone": raw.addCone(buf, op.c, op.rad, op.h, col, op.seg, null); break;
        case "frustum": raw.addFrustum(buf, op.c, op.rB, op.rT, op.h, col, op.seg, null); break;
      }
      // a swaying op is a crown: round its normals toward the canonical axis
      // (the same pass nature.js's swayOff() runs on inline emission)
      if (op.sway && raw.roundNormals) raw.roundNormals(buf, v0, _ORIGIN, _UP);
    }
    buf._mat = 0; buf._matAt = null;
    return buf;
  }

  // graph.js:115-127.
  function aabbOf(geo: CanonicalGeo | null): Aabb {
    const mn: [number, number, number] = [Infinity, Infinity, Infinity];
    const mx: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    const p = geo && geo.pos;
    if (!p || !p.length) return { mn: [0, 0, 0], mx: [0, 0, 0] };
    for (let i = 0; i < p.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const v = p[i + a]!;
        if (v < mn[a]!) mn[a] = v;
        if (v > mx[a]!) mx[a] = v;
      }
    }
    return { mn, mx };
  }

  // graph.js:128-157: define a model once; `build(rec)` records ops in canonical
  // space. The canonical mesh is built LAZILY (stats(), or an instanced renderer
  // uploading one mesh per model), so a plain build emits EXACTLY the primitives
  // it ships. Closure-scoped so a destructured or spread record still resolves.
  function model(key: string, build: ModelBuild): GraphModel {
    let m = models.get(key);
    if (m) return m;
    const ops: GraphOp[] = [];
    build(recorder(ops));
    let geo: CanonicalGeo | null | undefined, aabb: Aabb | undefined;
    const meshOf = () => (geo === undefined ? (geo = bakeCanonical(ops)) : geo);
    m = {
      key, ops, uses: 0,
      hasRadial: ops.some((o) => o.op === "cyl" || o.op === "cone" || o.op === "frustum"),
      nodeColored: ops.some((o) => o.col === NODE_COLOR),
      get geo() { return meshOf(); },
      get aabb() { return aabb === undefined ? (aabb = aabbOf(meshOf())) : aabb; },
      get verts() { const g = meshOf(); return g ? g.pos.length / 3 : 0; },
    };
    models.set(key, m);
    return m;
  }

  // graph.js:159-211.
  function replay(m: GraphModel, place: GraphPlace, emit: GraphEmitters, out: GraphOut): number {
    const s = place.s;
    const rs = radScale(s), us = upScale(s);
    const basis: Basis = [place.r, place.u, place.t];
    let landed = 0;
    // Deliberately does NOT save/restore out._mat: the register's trailing state
    // is the migrated helper's business, exactly as it was when it emitted inline.
    let swayed = false;
    for (const op of m.ops) {
      const c = xform(place, op.c);
      if (op.mat !== undefined) out._mat = op.mat;
      // Sway weight rides on out._matAt for this op only; cleared below so the
      // next baked emitter never inherits a crown's callback (graph.js:168-171).
      out._matAt = op.sway ? swayAt(out._mat || 0, place.o, place.u, upScale(s), op.sway) : null;
      if (op.sway) swayed = true;
      const col = colourOf(op, place);
      let ok: boolean | void = false;
      const v0 = out.pos.length / 3;
      switch (op.op) {
        case "box":
        case "prism":
        case "pyramid": {
          const sz: RVec3 = s ? [op.sz[0] * __M.abs(s[0]), op.sz[1] * __M.abs(s[1]), op.sz[2] * __M.abs(s[2])] : op.sz;
          ok = op.op === "box" ? emit.addBox(out, c, sz, col, basis)
            : op.op === "prism" ? emit.addPrism(out, c, sz, col, basis)
              : emit.addPyramid(out, c, sz, col, basis);
          break;
        }
        case "cyl": ok = emit.addCyl(out, c, op.rad * rs, op.h * us, col, op.seg, basis); break;
        case "cone": ok = emit.addCone(out, c, op.rad * rs, op.h * us, col, op.seg, basis); break;
        case "frustum": ok = emit.addFrustum(out, c, op.rB * rs, op.rT * rs, op.h * us, col, op.seg, basis); break;
      }
      // a swaying op is a crown: round its normals toward the placed axis.
      // Keyed on vertices landing, not `ok`: the raw emitter returns nothing.
      if (op.sway && emit.roundNormals && out.pos.length / 3 > v0) emit.roundNormals(out, v0, place.o, place.u);
      if (ok) landed++;
      // graph.js:196-206: a model is ONE object — a cylinder the PIT COMPLEX
      // kept out is its footing, so on a pit rejection while verdicts are being
      // decided the remaining ops record a culled verdict and the replay stops.
      if (!ok && op.op === "cyl" && out._pitRejected && !out._replayVerdicts) {
        if (out._recVerdicts) for (let r = m.ops.indexOf(op) + 1; r < m.ops.length; r++) out._recVerdicts[out._vIdx!++] = 0;
        break;
      }
    }
    if (swayed) out._matAt = null;
    return landed;
  }

  // graph.js:213-288.
  function instance(
    key: string, place: GraphPlace | null | undefined, build: ModelBuild,
    meta: GraphMeta | null | undefined, emit: GraphEmitters | null | undefined, out: GraphOut,
  ): number {
    if (!place || !isVec3(place.o) || !isVec3(place.r) || !isVec3(place.u) || !isVec3(place.t)) {
      dropped++;
      return 0;
    }
    const m = model(key, build);
    if (!m.ops.length) { dropped++; return 0; }
    // graph.js:218-232: a pine is one object. Dry-run the guards; if any op would
    // drop, plant nothing. `meta.whole` asks the same of any other model.
    let whole: Uint8Array | null = null;
    if (meta && (meta.kind === "pine" || meta.whole) && emit) {
      const verd = m._whole || (m._whole = new Uint8Array(m.ops.length));
      out._dryRun = true;
      out._recVerdicts = verd;
      out._vIdx = 0;
      const nLand = replay(m, place, emit, out);
      out._dryRun = false; out._recVerdicts = null;
      if (nLand !== m.ops.length) { dropped++; return 0; }
      whole = verd;     // every op passed: these ARE the verdicts, never re-guard
    }
    const prefer = !!(out && out._preferInstance && emit);
    let landed: number, verd = whole;
    if (prefer && whole) {
      landed = m.ops.length;
    } else if (prefer) {
      // graph.js:238-245: the dry run records a per-op verdict (1=pass 0=culled
      // 2=invalid) the fuse/absorb replay below consumes.
      out._dryRun = true;
      out._recVerdicts = verd = m._verd || (m._verd = new Uint8Array(m.ops.length));
      out._vIdx = 0;
      landed = replay(m, place, emit!, out);
      out._dryRun = false; out._recVerdicts = null;
    } else if (whole) {
      out._replayVerdicts = whole; out._vIdx = 0;
      landed = replay(m, place, emit!, out);
      out._replayVerdicts = null;
    } else {
      landed = emit ? replay(m, place, emit, out) : 0;
    }
    if (landed) {
      m.uses++;
      const full = landed === m.ops.length;
      const s = place.s;
      const nonUniformXZ = !!s && __M.abs(__M.abs(s[0]) - __M.abs(s[2])) > 1e-9;
      const skipFuse = prefer && full && !(m.hasRadial && nonUniformXZ);
      nodes.push({
        model: key,
        o: place.o, r: place.r, u: place.u, t: place.t,
        s: place.s || null,
        col: place.col || null,
        landed,
        full,
        // Did this placement's TRIANGLES stay out of a buffer? (graph.js:270-273)
        inst: skipFuse,
        meta: meta || null,
      });
      if (prefer && !skipFuse) {
        out._replayVerdicts = verd; out._vIdx = 0;
        replay(m, place, emit!, out);           // fuse bakeOnly into the soup
        out._replayVerdicts = null;
      } else if (prefer && skipFuse) {
        out._absorbOnly = true;                // terrain seating, no triangles
        out._replayVerdicts = verd; out._vIdx = 0;
        replay(m, place, emit!, out);
        out._absorbOnly = false; out._replayVerdicts = null;
      }
    }
    return landed;
  }

  // graph.js:290-298.
  function bake(emit: GraphEmitters, out: GraphOut): number {
    let landed = 0;
    for (const node of nodes) {
      const m = models.get(node.model);
      if (!m) continue;
      landed += replay(m, node, emit, out);
    }
    return landed;
  }

  // graph.js:300-329: register a pack mesh once per key as a COMPACTED copy
  // (only the vertices its indices reference, remapped in first-use order),
  // with `mat` forced to one id when the placement asks.
  function meshModel(key: string, mesh: BakedMesh, mat?: number | null): MeshRecord {
    let m = meshes.get(key);
    if (m) return m;
    const si = mesh.idx, nv = mesh.pos.length / 3;
    const remap = new Int32Array(nv).fill(-1);
    const idx = new Uint32Array(si.length);
    let n = 0;
    for (let i = 0; i < si.length; i++) {
      const v = si[i]!;
      if (remap[v]! < 0) remap[v] = n++;
      idx[i] = remap[v]!;
    }
    const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), col = new Float32Array(n * 3);
    const mt = new Float32Array(n);
    for (let v = 0; v < nv; v++) {
      const d = remap[v]!;
      if (d < 0) continue;
      pos[d * 3] = mesh.pos[v * 3]!; pos[d * 3 + 1] = mesh.pos[v * 3 + 1]!; pos[d * 3 + 2] = mesh.pos[v * 3 + 2]!;
      if (mesh.nrm) { nrm[d * 3] = mesh.nrm[v * 3]!; nrm[d * 3 + 1] = mesh.nrm[v * 3 + 1]!; nrm[d * 3 + 2] = mesh.nrm[v * 3 + 2]!; }
      else nrm[d * 3 + 1] = 1;
      if (mesh.col) { col[d * 3] = mesh.col[v * 3]!; col[d * 3 + 1] = mesh.col[v * 3 + 1]!; col[d * 3 + 2] = mesh.col[v * 3 + 2]!; }
      else { col[d * 3] = col[d * 3 + 1] = col[d * 3 + 2] = 0.7; }
      mt[d] = mat != null ? mat : (mesh.mat ? mesh.mat[v]! : 0);
    }
    m = { key, geo: { pos, nrm, col, mat: mt, idx }, verts: n, tris: idx.length / 3, places: [], tinted: false };
    meshes.set(key, m);
    return m;
  }
  // graph.js:330-340: one placement of a registered mesh — the transform
  // TrackGeom.addMesh applies (yaw about +Y, uniform scale, then translate).
  function meshPlace(key: string, x: number, y: number, z: number, yaw: number, scale?: number | null, tint?: RVec3 | null): boolean {
    const m = meshes.get(key);
    if (!m) return false;
    m.places.push({ x, y, z, yaw, s: scale != null ? scale : 1, tint: tint || null });
    if (tint) m.tinted = true;
    return true;
  }
  // graph.js:341-370.
  function meshBatches(out: GraphBatch[]): void {
    for (const m of meshes.values()) {
      const count = m.places.length;
      if (!count) continue;
      const matrices = new Float32Array(count * 16);
      const colors = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const p = m.places[i]!, cs = __M.cos(p.yaw), sn = __M.sin(p.yaw), s = p.s, b = i * 16;
        // addMesh: x' = px*cs + pz*sn + x; z' = -px*sn + pz*cs + z (column-major).
        matrices[b] = cs * s;      matrices[b + 2] = -sn * s;
        matrices[b + 5] = s;
        matrices[b + 8] = sn * s;  matrices[b + 10] = cs * s;
        matrices[b + 12] = p.x;    matrices[b + 13] = p.y;    matrices[b + 14] = p.z;
        matrices[b + 15] = 1;
        const c = p.tint || WHITE;
        colors[i * 3] = c[0]; colors[i * 3 + 1] = c[1]; colors[i * 3 + 2] = c[2];
      }
      out.push({ model: "mesh:" + m.key, geo: m.geo, verts: m.verts, count, matrices, colors });
    }
  }

  // graph.js:372-433. Plain, this answers "what COULD be instanced" (a
  // capability report). `opts.instancedOnly` narrows it to the nodes whose
  // triangles were WITHHELD from a buffer; a caller that UPLOADS the result must
  // ask for that set or it draws twice everything already fused (graph.js:376-391).
  function batches(opts?: { readonly instancedOnly?: boolean } | null): { batches: GraphBatch[]; bakeOnly: GraphNode[] } {
    const instancedOnly = !!(opts && opts.instancedOnly);
    const byModel = new Map<string, GraphNode[]>();
    const bakeOnly: GraphNode[] = [];
    for (const node of nodes) {
      const m = models.get(node.model);
      if (!m) continue;
      if (instancedOnly && !node.inst) continue;
      const s = node.s;
      const nonUniformXZ = !!s && __M.abs(__M.abs(s[0]) - __M.abs(s[2])) > 1e-9;
      if (!node.full || (m.hasRadial && nonUniformXZ)) { bakeOnly.push(node); continue; }
      let list = byModel.get(node.model);
      if (!list) byModel.set(node.model, (list = []));
      list.push(node);
    }

    const out: GraphBatch[] = [];
    for (const [key, list] of byModel) {
      const m = models.get(key)!;
      const count = list.length;
      const matrices = new Float32Array(count * 16);
      const colors = m.nodeColored ? new Float32Array(count * 3) : null;
      for (let i = 0; i < count; i++) {
        const n = list[i]!, o = n.o, r = n.r, u = n.u, t = n.t, s = n.s;
        const sx = s ? s[0] : 1, sy = s ? s[1] : 1, sz = s ? s[2] : 1;
        const b = i * 16;
        matrices[b]      = r[0] * sx; matrices[b + 1]  = r[1] * sx; matrices[b + 2]  = r[2] * sx;
        matrices[b + 4]  = u[0] * sy; matrices[b + 5]  = u[1] * sy; matrices[b + 6]  = u[2] * sy;
        // graph.js:409-415: the track frame is left-handed (r×u · t < 0);
        // negating the t column restores det > 0 so back-face culling holds.
        const cr0 = r[1] * u[2] - r[2] * u[1];
        const cr1 = r[2] * u[0] - r[0] * u[2];
        const cr2 = r[0] * u[1] - r[1] * u[0];
        const tz = (cr0 * t[0] + cr1 * t[1] + cr2 * t[2]) < 0 ? -sz : sz;
        matrices[b + 8]  = t[0] * tz; matrices[b + 9]  = t[1] * tz; matrices[b + 10] = t[2] * tz;
        matrices[b + 12] = o[0];      matrices[b + 13] = o[1];      matrices[b + 14] = o[2];
        matrices[b + 15] = 1;
        if (colors) {
          const c = n.col || WHITE;
          colors[i * 3] = c[0]; colors[i * 3 + 1] = c[1]; colors[i * 3 + 2] = c[2];
        }
      }
      out.push({ model: key, geo: m.geo, verts: m.verts, count, matrices, colors });
    }
    meshBatches(out);   // in BOTH sets: a mesh placement is recorded only when its triangles were withheld
    // Deterministic order: a backend uploading these must not have its draw
    // list reshuffle between builds of the same track.
    out.sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
    return { batches: out, bakeOnly };
  }

  // graph.js:435-473.
  function stats(): GraphStats {
    let unique = 0, fused = 0;
    for (const m of models.values()) {
      unique += m.verts;
      fused += m.verts * m.uses;
    }
    const byKind: Record<string, KindStats> = {};
    const seen = new Map<string, Set<string>>();   // kind -> Set of model keys
    for (const node of nodes) {
      const kind = (node.meta && node.meta.kind) || "(unkeyed)";
      const m = models.get(node.model);
      if (!m) continue;
      let e = byKind[kind];
      if (!e) { e = byKind[kind] = { nodes: 0, models: 0, fusedVerts: 0, uniqueVerts: 0, reuse: 0 }; seen.set(kind, new Set()); }
      e.nodes++;
      e.fusedVerts += m.verts;
      const set = seen.get(kind)!;
      if (!set.has(node.model)) { set.add(node.model); e.models++; e.uniqueVerts += m.verts; }
    }
    for (const kind in byKind) {
      const e = byKind[kind]!;
      e.reuse = e.uniqueVerts > 0 ? e.fusedVerts / e.uniqueVerts : 0;
    }
    let mModels = 0, mInst = 0, mUnique = 0, mFused = 0;
    for (const m of meshes.values()) {
      if (!m.places.length) continue;
      mModels++; mInst += m.places.length; mUnique += m.verts; mFused += m.verts * m.places.length;
    }
    return {
      models: models.size,
      nodes: nodes.length,
      dropped,
      mesh: { models: mModels, instances: mInst, uniqueVerts: mUnique, fusedVerts: mFused },
      uniqueVerts: unique,          // what an instanced renderer uploads
      fusedVerts: fused,            // what the soup costs today
      reuse: unique > 0 ? fused / unique : 0,
      byKind,
    };
  }

  return { models, nodes, meshes, model, instance, replay, bake, batches, stats, meshModel, meshPlace };
}
