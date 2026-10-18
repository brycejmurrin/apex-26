/**
 * SceneryStructures: the linear track furniture and race-infrastructure band
 * of the buildProps composite-model toolkit: the `along()` node walker, the
 * barriers (wall, fence, guardrail, tyreWall), the start gantry, marshal posts,
 * camera towers, sponsor hoardings, the seating family (bleacher,
 * scaffoldStand, terrace, tieredBowl), sign boards and the ferris wheel.
 *
 * Port of f1-game js/track/scenery/structures.js:1-1058 (`SceneryStructures`).
 * Verbatim: float math keeps f1-game's operation order (including its
 * `Math.hypot` calls). Engine globals come from the injected `core`
 * (`TrackGeom.SEP_SLOTS`/`MIN_SEP` -> core.geom, `M4.clamp` -> core.scalar,
 * `Tracks.terrainY` -> core.tracks). The `Log.info`/`Log.warn` traces
 * (structures.js:11, :60-61) are dropped: they do not affect output.
 */
import type {
  Basis, OverheadSpanSpec, RVec3, SceneryAnchor, SceneryApi, SceneryBuffer,
} from "../../contracts/scenery";
import type { Vec3 } from "../../contracts/track";
import type { BuildTrack, GeomCore, SceneryCore } from "./core";
import { CROWD_DAY, SIGN_DIGIT, SIGN_SEG } from "./data";
import type { GraphMeta, GraphPlace, Recorder } from "./graph";

/** `instance` opts. build-props.js:570-575. */
export interface InstanceOpts {
  readonly buf?: SceneryBuffer;
  readonly unguarded?: boolean;
  readonly roundNormals?: boolean;
}

/** The raw (unguarded) emitters, build-props.js:13 `RAW`. */
export type RawEmitters = Pick<
  GeomCore, "addBox" | "addCyl" | "addCone" | "addFrustum" | "addPrism" | "addPyramid" | "addMountain"
>;

/** The buildProps ctx members structures.js:6-10 destructures and reads (build-props.js:1338-1361). */
export interface StructuresCtx {
  readonly out: SceneryBuffer;
  readonly track: BuildTrack;
  readonly n: number;
  readonly ds: number;
  readonly hw: Float32Array;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly NIGHT: boolean;
  readonly MAT: SceneryApi["MAT"];
  /** build-props.js:942: geometry-only barrier (solid to scenery, no driving limit). */
  indexBarrier(s0: number, s1: number, side: number, gap: number): void;
  readonly addBox: SceneryApi["addBox"];
  readonly addCyl: SceneryApi["addCyl"];
  readonly addFrustum: SceneryApi["addFrustum"];
  readonly addPrism: SceneryApi["addPrism"];
  readonly RAW: RawEmitters;
  /** build-props.js:595. */
  blockAt(k: number, side: number, innerGap: number, halfM?: number): void;
  /** build-props.js:607 (structures.js:379 guards it with `if (post)`). */
  readonly post?: (k: number, side: number, dist: number, halfX: number, halfM: number) => void;
  readonly recordBarrier: SceneryApi["recordBarrier"];
  readonly groundYAt: SceneryApi["groundYAt"];
  readonly terrainYAt: SceneryApi["terrainYAt"];
  readonly onTrack: SceneryApi["onTrack"];
  readonly overheadSpan: (spec: OverheadSpanSpec) => boolean;
  readonly hash: SceneryApi["hash"];
  readonly cross: SceneryApi["cross"];
  readonly norm: SceneryApi["norm"];
  readonly vadd: SceneryApi["vadd"];
  /** nature.js:92 (SceneryNature, created before this kit). */
  readonly anchor: (k: number, side: number, dist: number) => SceneryAnchor;
  /** guards.js:129: true = the box footprint covers tarmac. */
  rejBox(c: RVec3, sz: RVec3, basis?: Basis | null): boolean;
  /** build-props.js:363. */
  noteSpan(kind: string, s0: number, s1: number, side: number, gap: number, extra?: object): void;
  /** build-props.js:299. */
  noteSuppressed(kind: string, msg: string): void;
  /** build-props.js:332. TODO(scenery build-props port): type the record. */
  note(kind: string, c: RVec3, size: RVec3, extra?: object): unknown;
  /** build-props.js:570: primitives that survived the guards. */
  instance(key: string, place: GraphPlace, build: (rec: Recorder) => unknown,
           meta?: GraphMeta, opts?: InstanceOpts): number;
  /** build-props.js:1356: the circuit's kit style for a furniture family. */
  kitOf(family: string, fallback: string): string;
  readonly indexSolid: SceneryApi["indexSolid"];
}

export type FenceOpts = { readonly style?: string; readonly postCol?: RVec3 };
export type GuardrailOpts = { readonly style?: string; readonly postCol?: RVec3 };
export type TyreWallOpts = { readonly style?: string; readonly tyreCol?: RVec3 };
export type GantryOpts = { readonly style?: string };
export type MarshalPostOpts = { readonly style?: string; readonly roofCol?: RVec3 };
export type CameraTowerOpts = {
  readonly h?: number; readonly col?: RVec3; readonly style?: string;
  readonly railCol?: RVec3; readonly boom?: number;
};
export type SponsorHoardingOpts = {
  readonly h?: number; readonly step?: number; readonly postCol?: RVec3;
  readonly style?: string; readonly palette?: readonly RVec3[];
};
export type BleacherOpts = {
  readonly rows?: number; readonly rise?: number; readonly setback?: number;
  readonly frame?: string; readonly frameCol?: RVec3; readonly plankCol?: RVec3;
  readonly riserCol?: RVec3; readonly density?: number; readonly step?: number;
  readonly lift?: number; readonly rail?: boolean; readonly crowd?: readonly RVec3[];
};
export type ScaffoldStandOpts = {
  readonly rows?: number; readonly rise?: number; readonly setback?: number;
  readonly tubeCol?: RVec3; readonly deckCol?: RVec3; readonly bench?: readonly RVec3[];
  readonly density?: number; readonly step?: number; readonly legEvery?: number;
  readonly crowd?: readonly RVec3[]; readonly awning?: boolean; readonly awningCols?: readonly RVec3[];
};
export type TerraceOpts = {
  readonly rows?: number; readonly rise?: number; readonly depth?: number;
  readonly conc?: RVec3; readonly concAlt?: RVec3; readonly density?: number;
  readonly step?: number; readonly retainer?: boolean; readonly crowd?: readonly RVec3[];
  readonly backWall?: boolean; readonly cut?: boolean; readonly cutCol?: RVec3;
};
export type TieredBowlOpts = {
  readonly tiers?: number; readonly tierDepth?: number; readonly base?: number;
  readonly rise?: number; readonly shell?: readonly RVec3[]; readonly fascia?: RVec3;
  readonly density?: number; readonly step?: number; readonly crowd?: readonly RVec3[];
  readonly roof?: boolean; readonly roofCol?: RVec3;
};

/** structures.js:1050-1053: what `create` returns (merged into ctx and the api). */
export interface StructuresApi {
  along(s0: number, s1: number, stepM: number, fn: (k: number, stepMetres: number) => void, tag?: string): void;
  wall(s0: number, s1: number, side: number, gap: number, h: number, col?: RVec3 | null, thick?: number, alt?: number): void;
  fence(s0: number, s1: number, side: number, gap: number, h: number, col?: RVec3 | null, opts?: FenceOpts | null): void;
  guardrail(s0: number, s1: number, side: number, gap: number, col?: RVec3 | null, opts?: GuardrailOpts | null): void;
  tyreWall(s0: number, s1: number, side: number, gap: number, capCol?: RVec3 | null, opts?: TyreWallOpts | null): void;
  gantry(s: number, h: number, col?: RVec3 | null, opts?: GantryOpts | null): void;
  flagQuad(c: RVec3, t: RVec3, u: RVec3, w: number, h: number, col: RVec3, still?: boolean): void;
  marshalPost(k: number, side: number, gap: number, opts?: MarshalPostOpts | null): void;
  cameraTower(k: number, side: number, gap: number, opts?: CameraTowerOpts | null): void;
  sponsorHoarding(s0: number, s1: number, side: number, gap: number, opts?: SponsorHoardingOpts | null): void;
  signDigit(c: RVec3, r: RVec3, u: RVec3, t: RVec3, w: number, h: number, proud: number, col: RVec3, digit: number): void;
  signBoard(k: number, side: number, gap: number, kind: string, value: number): void;
  ferrisWheel(k: number, side: number, dist: number, radius: number): void;
  bleacher(s0: number, s1: number, side: number, gap: number, opts?: BleacherOpts | null): void;
  scaffoldStand(s0: number, s1: number, side: number, gap: number, opts?: ScaffoldStandOpts | null): void;
  terrace(s0: number, s1: number, side: number, gap: number, opts?: TerraceOpts | null): void;
  tieredBowl(s0: number, s1: number, side: number, gap: number, opts?: TieredBowlOpts | null): void;
}

export function create(ctx: StructuresCtx, core: SceneryCore): StructuresApi {
  const { out, track, n, ds, hw, px, py, pz, NIGHT, MAT,
          indexBarrier,
          addBox, addCyl, addFrustum, addPrism, RAW, blockAt, post, recordBarrier,
          groundYAt, terrainYAt, onTrack, overheadSpan, hash, cross, norm, vadd,
          anchor, rejBox } = ctx;

  // structures.js:14-69: containment test so a linear run already laid at the
  // same side, gap and style is not laid again (coincident geometry).
  const laid = new Map<string, [number, number][]>();   // key -> [[a, b], …] lap-fraction runs already emitted
  let reLaidWarned = false;
  const alreadyLaid = (kind: string, s0: number, s1: number, side: number, gap: number, style: string): boolean => {
    const key = `${kind}|${side}|${Math.round(gap * 10)}|${style || ""}`;
    const runs = laid.get(key) || [];
    const a = s0 % 1, full = Math.abs(s1 - s0) >= 0.999;
    let b = s1 > s0 && s1 % 1 === 0 ? 1 : s1 % 1;
    if (!full && b < a) b += 1;
    const within = (ra: number, rb: number) => [0, 1, -1].some((o) => a + o >= ra - 1e-6 && b + o <= rb + 1e-6);
    for (const [ra, rb] of runs) {
      const rFull = Math.abs(rb - ra) >= 0.999;
      if (rFull || (!full && within(ra, rb))) {
        // structures.js:58-62 Log.warn once per circuit (dropped: no output effect).
        if (!reLaidWarned) reLaidWarned = true;
        return true;
      }
    }
    runs.push([a, full ? a + 1 : b]);
    laid.set(key, runs);
    return false;
  };
  // structures.js:70-118: abutting spans share their seam node; `tag` dedupes
  // a node already drawn under the same geometric identity and continues the
  // previous run's step lattice.
  const walked = new Map<string, Set<number>>();
  const along = (s0: number, s1: number, stepM: number, fn: (k: number, stepMetres: number) => void, tag?: string): void => {
    const k0 = ((Math.round(s0 * n) % n) + n) % n, k1 = ((Math.round(s1 * n) % n) + n) % n;
    const wrapped = ((k1 - k0) + n) % n;
    const span = wrapped === 0 && Math.abs(s1 - s0) > 0.5 ? n - 1 : wrapped;
    const step = Math.max(1, Math.round(stepM / ds));
    let seen: Set<number> | null | undefined = null, i0 = 0;
    if (tag) {
      seen = walked.get(tag);
      if (!seen) walked.set(tag, seen = new Set());
      for (let d = 1; d < step; d++) {
        if (seen.has((k0 - d + n) % n)) { i0 = step - d; break; }
      }
    }
    for (let i = i0; i <= span; i += step) {
      const k = (k0 + i) % n;
      if (seen) {
        if (seen.has(k)) continue;
        seen.add(k);
      }
      fn(k, step * ds);
    }
  };
  // Continuous solid wall (concrete / pit wall) at clearance `gap` beyond the edge. structures.js:120.
  const wall = (s0: number, s1: number, side: number, gap: number, h: number, col?: RVec3 | null, thick?: number, alt?: number): void => {
    const a = thick || 0.5;
    if (alreadyLaid("wall", s0, s1, side, gap, `${a}|${h}|${(col || []).join(",")}`)) return;
    ctx.noteSpan("wall", s0, s1, side, gap, { h });
    recordBarrier(s0, s1, side, gap);
    let n = 0;
    along(s0, s1, 6, (k, spacing) => {
      const p = anchor(k, side, gap);
      if (onTrack(p.c[0], p.c[2], a / 2)) {
        ctx.noteSuppressed("wall", `wall SUPPRESSED at k=${k} side=${side}: gap=${gap}`);
        return;
      }
      const wallCol: RVec3 = col || [0.78, 0.78, 0.80];
      const capCol: RVec3 = [wallCol[0] * 0.72, wallCol[1] * 0.72, wallCol[2] * 0.74];
      // `alt` (opt-in, metres): every other slab stands `alt` thicker (structures.js:134-136).
      const t = alt && (n++ & 1) ? a + alt : a;
      ctx.instance(`wall|${t}|${h}|${wallCol.join(",")}`,
        { o: p.c, r: p.r, u: p.u, t: p.t, s: [1, 1, spacing] },
        (rec) => {
          rec.box([0, (h - 0.4) / 2, 0], [t, h + 0.4, 1], wallCol);   // slab
          rec.box([0, h, 0], [t * 1.1, 0.16, 1], capCol);            // coping rail on top
        },
        { kind: "wall", k, side });
    }, `wall|${side}|${gap}|${a}|${h}|${(col || []).join(",")}`);
  };
  const kitOf = ctx.kitOf;

  // structures.js:148: catch fence (geometry-only barrier registration).
  const fence = (s0: number, s1: number, side: number, gap: number, h: number, col?: RVec3 | null, opts?: FenceOpts | null): void => {
    const st = (opts && opts.style) || kitOf("fence", "mesh");
    if (alreadyLaid("fence", s0, s1, side, gap, `${st}|${h}|${(col || []).join(",")}`)) return;
    ctx.noteSpan("fence", s0, s1, side, gap, { h });
    indexBarrier(s0, s1, side, gap);
    // Model keys are loop-invariant (structures.js:157-176); the "leaning"
    // style's key carries `side` because its top rail is offset by side.
    const postCol: RVec3 = (opts && opts.postCol) || [0.28, 0.28, 0.30];
    const meshCol: RVec3 = col || [0.72, 0.74, 0.78];
    const postKey = `fence-post|unit|${st}|${postCol.join(",")}`;
    const meshKey = `fence-mesh|${h}|${st}|${meshCol.join(",")}`
      + (st === "leaning" ? `|${side}` : "");
    along(s0, s1, 5, (k, spacing) => {
      const p = anchor(k, side, gap);
      if (onTrack(p.c[0], p.c[2], 0.5)) {
        ctx.noteSuppressed("fence", `fence SUPPRESSED at k=${k} side=${side}: gap=${gap}`);
        return;
      }
      const place = { o: p.c, r: p.r, u: p.u, t: p.t };
      // structures.js:184-193: carry a raised verge down to the rendered ground.
      // Unguarded in f1-game (throws without Tracks), hence the `!`.
      const terrain = core.tracks!.terrainY(track, p.c[0], p.c[2]);
      const surface = track["surface"] as { readonly floorY?: number } | null | undefined;
      const ground = Number.isFinite(terrain) ? terrain
        : surface && surface.floorY;
      const uy = p.u[1];
      const extra = Number.isFinite(ground) && Number.isFinite(uy) && uy > 0.1
        ? Math.max(0, (p.c[1] - (ground as number)) / uy - 0.4) : 0;
      const postPlace = { o: vadd(p.c, p.u, -0.4 - extra),
                          r: p.r, u: p.u, t: p.t, s: [1, h + 0.4 + extra, 1] as RVec3 };
      ctx.instance(postKey, postPlace,                                       // grounded footing; top unchanged
        (rec) => {
          rec.cyl([0, 0, 0], 0.13, 1, postCol, 5);
        },
        { kind: "fence", k, side });
      const span: GraphPlace = Object.assign({ s: [1, 1, spacing] as RVec3 }, place);
      ctx.instance(meshKey, span,
        (rec) => {
          if (st === "chainlink") {
            rec.box([0, h * 0.95, 0], [0.07, 0.07, 1], meshCol);
          } else if (st === "panelled") {
            for (const f of [0.30, 0.90])
              rec.box([0, h * f, 0], [0.09, 0.14, 1], meshCol);
          } else if (st === "hoarding") {
            // Solid printed sheet — street circuits screen the public road.
            rec.box([0, h * 0.52, 0], [0.09, h * 0.95, 1], meshCol);
            rec.box([0, h * 1.00, 0], [0.14, 0.10, 1], postCol);
          } else if (st === "palisade") {
            for (let i = 0; i < 3; i++)
              rec.box([0, h * 0.55, (i - 1) * 0.30], [0.06, h * 0.9, 0.09], meshCol);
            rec.box([0, h * 0.95, 0], [0.08, 0.07, 1], postCol);
          } else if (st === "leaning") {
            rec.box([0, h * 0.50, 0], [0.05, h * 0.80, 1], meshCol);
            rec.box([-side * h * 0.09, h * 0.95, 0], [h * 0.20, 0.05, 1], meshCol);
          } else {
            rec.box([0, h * 0.55, 0], [0.05, h * 0.9, 1], meshCol);           // mesh (default)
          }
        },
        { kind: "fence", k, side });
    }, `fence|${side}|${gap}|${postKey}|${meshKey}`);
  };
  // structures.js:227.
  const guardrail = (s0: number, s1: number, side: number, gap: number, col?: RVec3 | null, opts?: GuardrailOpts | null): void => {
    const st = (opts && opts.style) || kitOf("rail", "armco");
    if (alreadyLaid("guardrail", s0, s1, side, gap, st + "|" + (col || []).join(","))) return;
    ctx.noteSpan("guardrail", s0, s1, side, gap);
    recordBarrier(s0, s1, side, gap);
    const postCol: RVec3 = (opts && opts.postCol) || [0.5, 0.5, 0.52];
    const railCol: RVec3 = col || [0.82, 0.82, 0.85];
    const postKey = `guardrail-post|${st}|${postCol.join(",")}`;
    const railKey = `guardrail-rail|${st}|${railCol.join(",")}`;
    // The on-track margin must stay BELOW the gap (structures.js:237-241).
    const railMargin = Math.min(0.5, gap * 0.5);
    along(s0, s1, 4, (k, spacing) => {
      const p = anchor(k, side, gap);
      if (onTrack(p.c[0], p.c[2], railMargin)) {
        ctx.noteSuppressed("guardrail", `guardrail SUPPRESSED at k=${k} side=${side}: gap=${gap}`);
        return;
      }
      const place = { o: p.c, r: p.r, u: p.u, t: p.t };
      // A jersey barrier has no posts at all — it is a poured profile.
      if (st !== "jersey")
        ctx.instance(postKey, place,                                          // post, base sunk
          (rec) => rec.cyl([0, -0.35, 0], 0.09, st === "doubleArmco" ? 1.45 : st === "cable" ? 1.35 : 1.05, postCol, 4),
          { kind: "guardrail", k, side });
      ctx.instance(railKey,
        Object.assign({ s: [1, 1, spacing] as RVec3 }, place),
        (rec) => {
          if (st === "doubleArmco") {                    // old European two-rail
            rec.box([0, 0.62, 0], [0.18, 0.38, 1], railCol);
            rec.box([0, 1.16, 0], [0.18, 0.38, 1], railCol);
          } else if (st === "wArmco") {                  // the W cross-section
            rec.box([0, 0.72, 0], [0.20, 0.44, 1], railCol);
            rec.box([-0.07, 0.72, 0], [0.09, 0.16, 1], railCol);
          } else if (st === "jersey") {                  // poured concrete profile
            rec.box([0, 0.26, 0], [0.60, 0.52, 1], railCol);
            rec.box([0, 0.72, 0], [0.30, 0.46, 1], railCol);
          } else if (st === "cable") {                   // 1970s wire rope
            for (const y of [0.58, 0.95])
              rec.box([0, y, 0], [0.07, 0.07, 1], railCol);
          } else if (st === "safer") {                   // smooth tube over foam
            rec.box([0, 0.70, 0], [0.34, 0.62, 1], railCol);
            rec.box([0, 1.04, 0], [0.38, 0.10, 1], postCol);
          } else {
            rec.box([0, 0.7, 0], [0.18, 0.45, 1], railCol);                   // armco (default)
          }
        },
        { kind: "guardrail", k, side });
    }, `guardrail|${side}|${gap}|${postKey}|${railKey}`);
  };
  // Stacked-tyre barrier with a coloured conveyor-belt cap. structures.js:283-328.
  //   opts: { style: "stack"(default) | "tecpro" | "airfence", tyreCol }
  const tyreWall = (s0: number, s1: number, side: number, gap: number, capCol?: RVec3 | null, opts?: TyreWallOpts | null): void => {
    const st = (opts && opts.style) || kitOf("tyre", "stack");
    if (alreadyLaid("tyreWall", s0, s1, side, gap, st + "|" + (capCol || []).join(","))) return;
    ctx.noteSpan("tyreWall", s0, s1, side, gap);
    recordBarrier(s0, s1, side, gap);
    const tyre: RVec3 = (opts && opts.tyreCol) || [0.10, 0.10, 0.11];
    const cap: RVec3 = capCol || [0.9, 0.9, 0.92];
    // The key names every colour the model draws (structures.js:293-298).
    const slab = st === "tecpro" || st === "airfence";
    const stackKey = `tyre-stack|${st}|${tyre.join(",")}` + (slab ? `|${cap.join(",")}` : "");
    const capKey = `tyre-cap|${st}|${(slab ? tyre : cap).join(",")}`;
    along(s0, s1, 3.4, (k, spacing) => {
      const p = anchor(k, side, gap);
      if (onTrack(p.c[0], p.c[2], 1.0)) {
        ctx.noteSuppressed("tyreWall", `tyreWall SUPPRESSED at k=${k} side=${side}: gap=${gap}`);
        return;
      }
      // Same split as guardrail: fixed tyre stack, length-scaled conveyor cap.
      const place = { o: p.c, r: p.r, u: p.u, t: p.t };
      ctx.instance(stackKey, place,                                           // base sunk
        (rec) => {
          if (st === "tecpro") {
            rec.box([0, 0.20, 0], [1.5, 1.2, 1.6], cap);
            rec.box([0, 0.86, 0], [1.5, 0.14, 1.6], tyre);
          } else if (st === "airfence") {
            rec.frustum([0, -0.35, 0], 1.05, 0.72, 1.45, cap, 8);
          } else {
            rec.cyl([0, -0.35, 0], 1.0, 1.25, tyre, 7);                       // stack (default)
          }
        },
        { kind: "tyreWall", k, side });
      ctx.instance(capKey,
        Object.assign({ s: [1, 1, spacing] as RVec3 }, place),
        (rec) => {
          if (st === "tecpro") rec.box([0, 0.98, 0], [1.7, 0.16, 1], tyre);
          else if (st === "airfence") rec.box([0, 1.14, 0], [1.5, 0.14, 1], tyre);
          else rec.box([0, 0.95, 0], [2.0, 0.3, 1], cap);                     // stack (default)
        },
        { kind: "tyreWall", k, side });
    }, `tyreWall|${side}|${gap}|${stackKey}|${capKey}`);
  };
  // Start gantry across the track at fraction `s`. structures.js:329-398.
  const gantry = (s: number, h: number, col?: RVec3 | null, opts?: GantryOpts | null): void => {
    const st = (opts && opts.style) || kitOf("gantry", "box");
    const k = ((Math.round(s * n) % n) + n) % n, c: RVec3 = col || [0.16, 0.16, 0.19];
    const aL = anchor(k, -1, 1.5), aR = anchor(k, 1, 1.5), u = aL.u;
    const beam: RVec3 = [px[k]! + u[0] * h, py[k]! + u[1] * h, pz[k]! + u[2] * h];
    const housing = vadd(beam, u, -0.62);   // the lamp housing's centre (below)
    // `lamp`/`face` name the start lamps' row exactly (structures.js:335-338).
    ctx.note("gantry", [(aL.c[0] + aR.c[0]) / 2, aL.c[1] + h / 2,
                        (aL.c[2] + aR.c[2]) / 2],
             [Math.hypot(aR.c[0] - aL.c[0], aR.c[2] - aL.c[2]), h, 1],
             { k, side: 0, lamp: housing, face: 0.30 });   // side 0 = straddles the road
    const b: Basis = [aL.r, u, aL.t];
    const uy = Math.max(0.5, u[1]);
    const legH = (aC: RVec3) => (h - 0.45) + (py[k]! - aC[1]) / uy + 0.3;   // +0.3 into the beam
    const mast = (aC: RVec3, basis: Basis) => {
      const L = legH(aC);
      if (st === "truss") {
        // Four slim uprights on a square, X-braced — a real lattice mast.
        for (const [dr, dt] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const)
          addCyl(out, vadd(vadd(aC, basis[0], dr * 0.55), basis[2], dt * 0.55),
            0.11, L, c, 4, basis);
        for (let i = 0; i < Math.max(2, Math.floor(L / 3)); i++)
          addBox(out, vadd(aC, basis[1], (i + 0.5) * (L / Math.max(2, Math.floor(L / 3)))),
            [1.3, 0.10, 1.3], c, basis);
      } else if (st === "portal") {
        addBox(out, vadd(aC, basis[1], L / 2), [1.5, L, 1.1], c, basis);      // solid leg
        addBox(out, vadd(aC, basis[1], L - 1.2), [2.2, 1.0, 1.5], c, basis);  // haunch
      } else if (st === "scaffold") {
        for (const dt of [-0.5, 0.5])
          addCyl(out, vadd(aC, basis[2], dt), 0.09, L, c, 4, basis);
        for (let i = 0; i < Math.max(2, Math.floor(L / 2.2)); i++)
          addBox(out, vadd(aC, basis[1], (i + 0.5) * (L / Math.max(2, Math.floor(L / 2.2)))),
            [0.16, 0.10, 1.3], c, basis);
      } else if (st === "cantilever") {
        addCyl(out, aC, 0.42, L, c, 8, basis);                                 // single fat mast
        addBox(out, vadd(vadd(aC, basis[1], L * 0.72), basis[0], 0),
          [1.0, 0.5, 0.9], c, basis);                                          // boom root
      } else {
        addCyl(out, aC, 0.3, L, c, 6, basis);                                  // box (default)
      }
    };
    // A cantilever gantry hangs from ONE side — that is its whole silhouette.
    mast(aL.c, b);
    if (st !== "cantilever") mast(aR.c, [aR.r, u, aR.t]);
    // Each leg is solid at hw+1.5: a POST, never a blockAt (structures.js:376-378).
    if (post) {
      const legX = ({ truss: 0.66, portal: 0.75, scaffold: 0.09, cantilever: 0.42, box: 0.3 } as { readonly [s: string]: number })[st] || 0.3;
      const legZ = ({ truss: 0.66, portal: 0.55, scaffold: 0.65, cantilever: 0.42, box: 0.3 } as { readonly [s: string]: number })[st] || 0.3;
      post(k, -1, 1.5, legX, legZ);
      if (st !== "cantilever") post(k, 1, 1.5, legX, legZ);
    }
    // Span legs: half-width + 1.5 m clearance each side + 1 m past each mast.
    overheadSpan({
      id: `gantry-${k}`, frac: s, clearance: h - 0.45,
      thickness: 0.9, depth: 1.4, span: hw[k]! * 2 + 5,
      color: c,
    });
    // One dark housing bar under the beam's centre carrying the five start
    // lamps (structures.js:391-395).
    const gl: RVec3 = NIGHT ? [0.30, 0.31, 0.34] : [0.16, 0.16, 0.19];
    RAW.addBox(out, housing, [4.9, 0.45, 0.5], gl, b);
  };
  // A double-sided quad off a pole: cloth that waves (MAT.FLAG), or `still`
  // — a rigid board, flat material, no wave. structures.js:399-417.
  const flagQuad = (c: RVec3, t: RVec3, u: RVec3, w: number, h: number, col: RVec3, still?: boolean): void => {
    const nv = norm(cross(t, u));   // face normal (shared by both sides)
    const push = (reverse: boolean) => {
      const base = out.pos.length / 3;
      for (const [ft, fu] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) {
        out.pos.push(c[0] + t[0] * ft * w + u[0] * fu * h,
                     c[1] + t[1] * ft * w + u[1] * fu * h,
                     c[2] + t[2] * ft * w + u[2] * fu * h);
        out.nrm.push(nv[0], nv[1], nv[2]);
        out.col.push(col[0], col[1], col[2]);
        out.mat!.push(still ? 0 : MAT.FLAG + ft * 0.4);   // per-vertex wave weight in the fraction
      }
      if (reverse) out.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
      else out.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    push(false); push(true);   // both windings → visible from either side
  };
  const MARSHAL_PANEL: RVec3 = [0.06, 0.06, 0.07];   // an unlit LED light panel
  // structures.js:419-503: hut + dark FIA light panel (lit by js/race/marshal-panels.js).
  const marshalPost = (k: number, side: number, gap: number, opts?: MarshalPostOpts | null): void => {
    const st = (opts && opts.style) || kitOf("marshal", "hut");
    const p = anchor(k, side, gap), b: Basis = [p.r, p.u, p.t];
    if (onTrack(p.c[0], p.c[2], 3)) {
      ctx.noteSuppressed("marshalPost", `marshalPost SUPPRESSED at k=${k} side=${side}: gap=${gap}`);
      return;
    }
    // POLE_LAT 1.12: the pole overlaps the hut's back face (structures.js:433-438).
    const POLE_LAT = 1.12;
    const polePos = vadd(p.c, p.r, side * POLE_LAT), panelAt = vadd(polePos, p.u, 3.3);
    const panel = vadd(vadd(vadd(panelAt, p.t, 0.525), p.u, 0.31), p.r, -side * 0.12);
    ctx.note("marshalPost", [p.c[0], p.c[1] + 1.2, p.c[2]], [1.2, 2.4, 1.2], { k, side, panel });
    const roof: RVec3 = (opts && opts.roofCol) || [0.95, 0.55, 0.08];
    ctx.instance(`marshalPost|${st}|${side}|${roof.join(",")}`,
      { o: p.c, r: p.r, u: p.u, t: p.t }, (rec) => {
      if (st === "cabin") {                          // timber lean-to, open front
        rec.box([0, 1.0, 0], [2.0, 2.8, 2.6], [0.52, 0.40, 0.28]); // top 2.4
        rec.prism([0, 2.30, 0], [2.2, 1.0, 2.4], roof);
        rec.box([-side * 0.95, 0.55, 0], [0.22, 1.8, 2.6], [0.40, 0.31, 0.22]);
      } else if (st === "container") {               // shipping container
        rec.box([0, 1.0, 0], [2.4, 2.6, 5.4], [0.28, 0.44, 0.40]);
        rec.box([0, 1.0, 0], [2.5, 1.0, 5.5], [0.22, 0.37, 0.34]);   // rib band
        rec.box([-side * 1.2, 1.0, 1.4], [0.10, 2.0, 1.8], roof);
      } else if (st === "kiosk") {                   // glazed booth, thin canopy
        for (const [dr, dt] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const)
          rec.cyl([dr * 0.95, -0.35, dt * 0.95], 0.07, 2.9, [0.55, 0.56, 0.60], 4);
        rec.box([0, 1.5, 0], [1.9, 1.5, 1.9], [0.32, 0.44, 0.52]); // top 2.25
        rec.box([0, 2.20, 0], [2.6, 0.20, 2.6], roof);             // 2.10..2.30
      } else if (st === "bunker") {                  // half-buried concrete cell
        rec.box([0, 0.55, 0], [3.0, 1.9, 3.0], [0.70, 0.70, 0.67]);
        rec.box([-side * 1.5, 0.95, 0], [0.14, 0.5, 2.2], [0.12, 0.13, 0.15]);
        rec.box([0, 1.6, 0], [3.4, 0.3, 3.4], roof);
        rec.box([side * 1.9, 0.25, 0], [1.6, 1.0, 3.4], [0.44, 0.40, 0.28]);
      } else if (st === "tent") {                    // fabric awning on poles
        for (const [dr, dt] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const)
          rec.cyl([dr * 1.1, -0.35, dt * 1.1], 0.06, 2.7, [0.60, 0.61, 0.64], 4);
        rec.mat(MAT.FABRIC);
        rec.prism([0, 2.25, 0], [2.8, 0.8, 2.8], roof);
        rec.mat(0);
      } else if (st === "tower") {                   // raised platform + ladder
        for (const [dr, dt] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const)
          rec.cyl([dr * 1.0, -0.35, dt * 1.0], 0.09, 3.6, [0.46, 0.47, 0.50], 4);
        rec.box([0, 3.3, 0], [2.6, 0.2, 2.6], [0.62, 0.63, 0.66]); // deck top 3.4
        rec.box([0, 3.35, 0], [2.6, 0.9, 0.10], roof);
        rec.box([side * 1.3, 1.6, 0], [0.10, 3.4, 0.6], [0.46, 0.47, 0.50]);
      } else {                                       // hut (default): pitched roof + door + window
        rec.box([0, 1.1, 0], [2.2, 3.0, 2.2], [0.85, 0.86, 0.88]);   // wall block, base sunk 0.4, top at 2.6
        rec.prism([0, 2.40, 0], [2.6, 1.0, 2.6], roof);
        rec.box([-side * 1.12, 0.55, 0], [0.12, 1.3, 0.9], [0.20, 0.21, 0.24]); // trackward doorway
        rec.box([-side * 1.12, 1.8, 0.6], [0.08, 0.6, 0.6], [0.34, 0.46, 0.55]); // window pane
      }
      // Pole against the back face; foot sunk 1.0 m (structures.js:493-495).
      rec.cyl([side * POLE_LAT, -1.0, 0], 0.08, 5.0, [0.4, 0.4, 0.42], 4);
      // Short arm chaining every style's wall to the pole (structures.js:496-498).
      rec.box([side * (POLE_LAT * 0.5), 1.55, 0], [POLE_LAT, 0.14, 0.14], [0.4, 0.4, 0.42]);
    }, { kind: "marshalPost", k, side });
    flagQuad(panelAt, p.t, p.u, 1.05, 0.62, MARSHAL_PANEL, true);
    if (NIGHT) addBox(out, vadd(polePos, p.u, 4.12), [0.24, 0.24, 0.24], [1.32, 0.72, 0.28], b);
    blockAt(k, side, gap, 1.3);   // solid hut
  };
  // structures.js:504-551.
  const cameraTower = (k: number, side: number, gap: number, opts?: CameraTowerOpts | null): void => {
    opts = opts || {};
    const h = Math.max(5, Math.min(40, opts.h != null ? opts.h : 14));
    const col: RVec3 = opts.col || [0.40, 0.42, 0.46];
    const p = anchor(k, side, gap), b: Basis = [p.r, p.u, p.t];
    const legR = 1.1;
    // Full-footprint guard: test the box, never a single point.
    if (rejBox(vadd(p.c, p.u, h / 2), [legR * 2 + 0.6, h, legR * 2 + 0.6], b)) {
      ctx.noteSuppressed("cameraTower", `cameraTower SUPPRESSED at k=${k} side=${side}: gap=${gap}`);
      return;
    }
    const cst = opts.style || kitOf("camera", "lattice");
    if (cst === "monopole") {
      // One tapered shaft — the modern broadcast mast. Cheapest form here.
      addFrustum(out, vadd(p.c, p.u, -0.4), 0.46, 0.24, h + 0.8, col, 8, b);
    } else if (cst === "scaffold") {
      for (const sr of [-1, 1]) for (const st of [-1, 1])
        addCyl(out, vadd(vadd(vadd(p.c, p.r, sr * legR * 0.7), p.t, st * legR * 0.7),
          p.u, -0.4), 0.09, h + 0.8, col, 4, b);
      for (let i = 1; i < Math.max(2, Math.round(h / 2.2)); i++)
        addBox(out, vadd(p.c, p.u, (i / Math.max(2, Math.round(h / 2.2))) * h),
          [legR * 1.5, 0.09, legR * 1.5], col, b);
    } else {
      for (const sr of [-1, 1]) for (const st of [-1, 1]) {
        const foot = vadd(vadd(p.c, p.r, sr * legR), p.t, st * legR);
        addCyl(out, vadd(foot, p.u, -0.4), 0.13, h + 0.8, col, 4, b);   // base-anchored: -0.4 → h+0.4
      }
      // X-bracing every ~3 m — what makes a lattice read as a lattice.
      const bays = Math.max(1, Math.round(h / 3));
      for (let i = 1; i < bays; i++) {
        const y = (i / bays) * h;
        for (const sr of [-1, 1])
          addBox(out, vadd(vadd(p.c, p.r, sr * legR), p.u, y), [0.1, 0.12, legR * 2], col, b);
        for (const st of [-1, 1])
          addBox(out, vadd(vadd(p.c, p.t, st * legR), p.u, y), [legR * 2, 0.12, 0.1], col, b);
      }
    }
    // Platform + seated track-facing guard panel supporting the camera head.
    addBox(out, vadd(p.c, p.u, h), [3.0, 0.2, 3.0], [0.52, 0.54, 0.58], b);
    addBox(out, vadd(vadd(p.c, p.r, -side * 1.4), p.u, h + 0.55), [0.09, 0.90, 3.0], opts.railCol || [0.70, 0.72, 0.76], b);
    // Camera head on a short boom, pointing back over the track.
    const head = vadd(vadd(p.c, p.u, h + 0.85), p.r, -side * (opts.boom != null ? opts.boom : 1.1));
    addBox(out, head, [0.75, 0.45, 0.5], [0.12, 0.12, 0.14], b);
    addCyl(out, vadd(head, p.r, -side * 0.42), 0.16, 0.3, [0.06, 0.06, 0.08], 6,
           [p.u, p.r, p.t]);
    blockAt(k, side, gap, legR + 0.4);
  };

  // structures.js:553-605.
  const sponsorHoarding = (s0: number, s1: number, side: number, gap: number, opts?: SponsorHoardingOpts | null): void => {
    opts = opts || {};
    const h = opts.h != null ? opts.h : 1.15;
    const step = opts.step || 9;
    const postCol: RVec3 = opts.postCol || [0.24, 0.25, 0.28];
    const hst = opts.style || kitOf("hoarding", "panel");
    const pal: readonly RVec3[] = (opts.palette && opts.palette.length) ? opts.palette : [
      [0.86, 0.16, 0.14], [0.94, 0.92, 0.90], [0.10, 0.34, 0.72],
      [0.96, 0.76, 0.06], [0.12, 0.52, 0.30], [0.16, 0.17, 0.20],
    ];
    let idx = 0;
    along(s0, s1, step, (k, spacing) => {
      const p = anchor(k, side, gap), b: Basis = [p.r, p.u, p.t];
      const panel = spacing * 0.92;
      const c = vadd(p.c, p.u, 0.45 + h / 2);
      if (rejBox(c, [0.16, h, panel], b)) return;
      const col = pal[idx % pal.length]!;
      if (hst === "banner") {                       // fabric slung between masts
        out._mat = MAT.FABRIC;
        addBox(out, vadd(c, p.u, 0.35), [0.08, h * 1.15, panel * 0.94], col, b);
        out._mat = 0;
        // Masts footed in the ground (sunk 0.3 m) up to the same h + 1.9 m top.
        for (const st of [-1, 1])
          addCyl(out, vadd(vadd(p.c, p.t, st * panel * 0.47), p.u, -0.3), 0.07, h + 2.2, postCol, 4, b);
      } else if (hst === "barrierTop") {            // bolted to the armco, no posts
        addBox(out, vadd(c, p.u, 0.35), [0.14, h * 0.9, panel], col, b);
      } else if (hst === "double") {                // two-tier board
        addBox(out, c, [0.16, h, panel], col, b);
        addBox(out, vadd(c, p.u, h * 0.92), [0.16, h * 0.8, panel], pal[(idx + 1) % pal.length]!, b);
        for (const st of [-1, 1])
          addBox(out, vadd(vadd(p.c, p.t, st * panel * 0.36), p.u, 0.22),
                 [0.13, 0.9, 0.14], postCol, b);
      } else if (hst === "led") {                   // continuous emissive ribbon
        const lit: RVec3 = NIGHT ? [Math.min(1.4, col[0] * 1.35 + 0.1), Math.min(1.4, col[1] * 1.35 + 0.1),
                                    Math.min(1.4, col[2] * 1.35 + 0.1)] : col;
        addBox(out, c, [0.12, h, panel], lit, b);
        addBox(out, vadd(c, p.u, h * 0.56), [0.2, 0.12, panel], postCol, b);
        // Two slim legs inside the ribbon's depth (structures.js:591-592).
        for (const st of [-1, 1])
          addBox(out, vadd(vadd(p.c, p.t, st * panel * 0.36), p.u, 0.22),
                 [0.07, 0.9, 0.10], postCol, b);
      } else {
        addBox(out, c, [0.16, h, panel], col, b);
        // Two stubby posts holding the board clear of the ground.
        for (const st of [-1, 1])
          addBox(out, vadd(vadd(p.c, p.t, st * panel * 0.36), p.u, 0.22),
                 [0.13, 0.9, 0.14], postCol, b);
      }
      idx++;
    }, `hoarding|${side}|${gap}|${h}|${hst}|${step}`);
  };

  // crowdBand(): the ONE crowd primitive these stands share: a continuous
  // banded run plus sparse speckle (structures.js:607-655).
  const CROWD_FALLBACK: readonly RVec3[] = [[0.86, 0.30, 0.24], [0.92, 0.90, 0.86],
                                            [0.24, 0.36, 0.62], [0.72, 0.63, 0.30]];
  // Per-call MIN_SEP slot (structures.js:619-625).
  let bandSeq = 0;
  const crowdBand = (c: RVec3, b: Basis, side: number, thick: number, h: number, len: number,
                     pal: readonly RVec3[] | null | undefined, dens: number, seed: number): void => {
    if (len <= 0.5) return;
    const slot = bandSeq++ % 4, SL = core.geom.SEP_SLOTS;
    c = vadd(vadd(c, b[0], side * SL[slot]!), b[2], SL[(slot * 3 + 1) % 4]!);
    const cols: readonly RVec3[] = (pal && pal.length) ? pal : (CROWD_DAY && CROWD_DAY.length ? CROWD_DAY : CROWD_FALLBACK);
    const pick = (t: number): RVec3 => NIGHT
      ? (t > 0.945 ? [2.5, 2.3, 1.9] : t > 0.55 ? [0.10, 0.11, 0.14] : [0.15, 0.16, 0.20])
      : cols[Math.floor(t * cols.length) % cols.length]!;
    const prevMat = out._mat;
    out._mat = MAT.FABRIC;
    const bt = hash(seed * 1.7);
    addBox(out, c, [thick, h, len], pick(NIGHT ? Math.min(0.94, bt) : bt), b);
    // One speckle head per ~6 m, capped (structures.js:639-642).
    const cnt = Math.min(16, Math.floor(len / 6));
    for (let i = 0; i < cnt; i++) {
      const hp = hash(seed + i * 13.7);
      if (hp > dens) continue;
      const headH = NIGHT ? 0.16 : 0.30;
      const skin = ([[0.83, 0.62, 0.44], [0.57, 0.35, 0.22], [0.94, 0.77, 0.60]] as const)[i % 3]!;
      const off = cnt > 1 ? (i / (cnt - 1) - 0.5) * (len - 2) : 0;
      addBox(out, vadd(vadd(vadd(c, b[2], off), b[1], h / 2 + headH / 2),
                       b[0], -side * thick * 0.25),
             [Math.min(thick * 0.5, 0.28), headH, NIGHT ? 0.18 : 0.28], NIGHT ? pick(hash(seed * 3.1 + i)) : skin, b);
    }
    out._mat = prevMat;
  };
  // structures.js:656-665: M4.clamp (output-identical to the old Math form here).
  const clamp = core.scalar.clamp;

  // structures.js:667-733.
  const bleacher = (s0: number, s1: number, side: number, gap: number, opts?: BleacherOpts | null): void => {
    opts = opts || {};
    const rows = clamp(Math.round(opts.rows || 7), 2, 16);
    const rise = opts.rise != null ? opts.rise : 0.72;      // per-row height gain
    const setback = opts.setback != null ? opts.setback : 0.95;   // per-row recede
    const timber = opts.frame === "timber";
    const frameCol: RVec3 = opts.frameCol || (timber ? [0.42, 0.33, 0.24] : [0.62, 0.63, 0.66]);
    const plankCol: RVec3 = opts.plankCol || (timber ? [0.55, 0.50, 0.43] : [0.60, 0.61, 0.64]);
    const riserCol: RVec3 = opts.riserCol || [plankCol[0] * 0.78, plankCol[1] * 0.78, plankCol[2] * 0.76];
    const dens = opts.density != null ? clamp(opts.density, 0.05, 1) : 0.62;
    const step = opts.step || 6;
    const lift = opts.lift || 0;
    const depth = rows * setback + 1.0;
    const topH = lift + 0.6 + rows * rise;
    ctx.noteSpan("bleacher", s0, s1, side, gap, { h: topH, rows });
    // A stand is a solid mass — index it so treelines cannot grow through it.
    ctx.indexSolid(s0, s1, side, gap, depth);
    const opt = opts;
    along(s0, s1, step, (k, spacing) => {
      const a = anchor(k, side, gap), b: Basis = [a.r, a.u, a.t];
      const seg = spacing * 0.98;   // see along(): a padded constant interpenetrates on curves
      if (rejBox(vadd(vadd(a.c, a.u, topH / 2), a.r, side * depth / 2),
                 [depth, topH, seg], b)) return;
      const backLat = side * (rows - 0.5) * setback;
      out._mat = timber ? MAT.WOOD : MAT.METAL;
      addCyl(out, vadd(a.c, a.u, -0.4), 0.14, 1.4, frameCol, 5, b);                    // front stub leg
      // Back leg runs up to the crest rail's mid-line (structures.js:693-696).
      const legH = opt.rail !== false ? topH + 0.95 : topH + 0.6;
      addCyl(out, vadd(vadd(a.c, a.r, backLat), a.u, -0.4), 0.17, legH, frameCol, 5, b);   // back leg
      // Horizontal ledgers every ~2.2 m — what makes a frame read as a frame.
      for (let y = 1.6; y < topH; y += 2.2)
        addBox(out, vadd(vadd(a.c, a.r, backLat / 2), a.u, y),
               [Math.abs(backLat) + 0.4, 0.12, 0.12], frameCol, b);
      // Diagonal cross-braces on the side face.
      if (topH > 2.5 && Math.abs(backLat) > 1.2) {
        const braceCol: RVec3 = [frameCol[0] * 0.9, frameCol[1] * 0.9, frameCol[2] * 0.92];
        for (const sgn of [-1, 1]) {
          const mid = vadd(vadd(a.c, a.r, backLat / 2), a.u, topH * 0.45);
          addBox(out, vadd(mid, a.t, sgn * seg * 0.42),
                 [Math.abs(backLat) * 0.95, 0.10, 0.10], braceCol, b);
        }
      }
      for (let r = 0; r < rows; r++) {
        const lat = side * r * setback, y = lift + 0.6 + r * rise;
        const rc = vadd(vadd(a.c, a.r, lat), a.u, y);
        out._mat = timber ? MAT.WOOD : MAT.METAL;
        addBox(out, rc, [setback * 1.05, 0.16, seg], plankCol, b);                     // tread plank
        // Foot board: nose MIN_SEP behind the plank's (structures.js:718-720).
        addBox(out, vadd(vadd(rc, a.r, -side * (setback * 0.525 - 0.08 - core.geom.MIN_SEP)), a.u, -rise * 0.5),
               [0.16, rise, seg], riserCol, b);                                        // foot board
        crowdBand(vadd(rc, a.u, 0.68), b, side, 0.58, 0.78, seg - 0.6,
                  opt.crowd, dens, k * 13.1 + r * 97.3 + side * 5.7);
      }
      if (opt.rail !== false) {
        out._mat = timber ? MAT.WOOD : MAT.METAL;
        addBox(out, vadd(vadd(a.c, a.r, backLat), a.u, topH + 0.55),
               [0.18, 0.16, seg], frameCol, b);
      }
      out._mat = 0;
    }, `bleacher|${side}|${gap}|${rows}|${rise}|${setback}|${lift}|${step}`);
  };

  // structures.js:735-790.
  const scaffoldStand = (s0: number, s1: number, side: number, gap: number, opts?: ScaffoldStandOpts | null): void => {
    opts = opts || {};
    const rows = clamp(Math.round(opts.rows || 5), 2, 12);
    const rise = opts.rise != null ? opts.rise : 1.15;
    const setback = opts.setback != null ? opts.setback : 1.9;
    const tube: RVec3 = opts.tubeCol || [0.62, 0.63, 0.66];
    const deck: RVec3 = opts.deckCol || [0.70, 0.66, 0.60];
    const bench: readonly RVec3[] = (opts.bench && opts.bench.length) ? opts.bench
      : [[0.80, 0.78, 0.74], [0.30, 0.36, 0.52], [0.72, 0.28, 0.24]];
    const dens = opts.density != null ? clamp(opts.density, 0.05, 1) : 0.58;
    const step = opts.step || 6;
    const legEvery = Math.max(1, Math.round(opts.legEvery || 2));
    const depth = rows * setback + 1.2;
    const topH = 1.2 + rows * rise;
    ctx.noteSpan("scaffoldStand", s0, s1, side, gap, { h: topH, rows });
    ctx.indexSolid(s0, s1, side, gap, depth);
    let bay = 0;
    const opt = opts;
    along(s0, s1, step, (k, spacing) => {
      const a = anchor(k, side, gap), b: Basis = [a.r, a.u, a.t];
      const seg = spacing * 0.98;
      if (rejBox(vadd(vadd(a.c, a.u, topH / 2), a.r, side * depth / 2),
                 [depth, topH, seg], b)) { bay++; return; }
      for (let r = 0; r < rows; r++) {
        const lat = side * r * setback, y = 1.2 + r * rise;
        const rc = vadd(vadd(a.c, a.r, lat), a.u, y);
        out._mat = MAT.WOOD;
        addBox(out, rc, [setback * 1.02, 0.18, seg], deck, b);                         // deck plank
        addBox(out, vadd(rc, a.u, 0.62), [setback * 0.5, 1.05, seg * 0.94],
               bench[(bay + r) % bench.length]!, b);                                   // bench
        crowdBand(vadd(rc, a.u, 1.55), b, side, 0.55, 0.95, seg - 1.0,
                  opt.crowd, dens, k * 17.3 + r * 89.1 + side * 3.3);
        if (bay % legEvery === 0) {
          out._mat = MAT.METAL;
          addCyl(out, vadd(vadd(a.c, a.r, lat), a.u, -0.4), 0.09, y + 0.4, tube, 4, b);
        }
      }
      out._mat = MAT.METAL;
      const backLat = side * (rows - 0.5) * setback;
      addCyl(out, vadd(vadd(a.c, a.r, backLat), a.u, -0.4), 0.13, topH + 1.6, tube, 5, b);  // back standard
      addBox(out, vadd(vadd(a.c, a.r, backLat), a.u, topH + 0.9),
             [0.11, 0.11, seg], tube, b);                                              // handrail
      // One leaning ledger per bay reads as the full X-brace at speed.
      addBox(out, vadd(vadd(a.c, a.r, backLat / 2), a.u, topH * 0.45),
             [Math.abs(backLat) + 0.6, 0.13, 0.13], tube, b);
      if (opt.awning) {
        const aw: readonly RVec3[] = (opt.awningCols && opt.awningCols.length) ? opt.awningCols
          : [[0.88, 0.86, 0.82], [0.80, 0.26, 0.22]];
        addCyl(out, vadd(vadd(a.c, a.r, backLat), a.u, topH + 1.4), 0.10, 2.6, tube, 5, b);
        out._mat = MAT.FABRIC;
        addBox(out, vadd(vadd(a.c, a.r, backLat * 0.45), a.u, topH + 3.6),
               [Math.abs(backLat) + 1.6, 0.22, seg], aw[bay % aw.length]!, b);
      }
      out._mat = 0;
      bay++;
    }, `scaffold|${side}|${gap}|${rows}|${rise}|${setback}|${step}`);
  };

  // structures.js:792-884.
  const terrace = (s0: number, s1: number, side: number, gap: number, opts?: TerraceOpts | null): void => {
    opts = opts || {};
    const rows = clamp(Math.round(opts.rows || 6), 2, 16);
    const rise = opts.rise != null ? opts.rise : 1.5;
    const dep = opts.depth != null ? opts.depth : 2.6;
    const conc: RVec3 = opts.conc || [0.72, 0.71, 0.67];
    const concAlt: RVec3 = opts.concAlt || [0.64, 0.63, 0.59];
    const dens = opts.density != null ? clamp(opts.density, 0.05, 1) : 0.55;
    const step = opts.step || 7;
    const depth = rows * dep + 2.4;
    const topH = 1.4 + rows * rise;
    ctx.noteSpan("terrace", s0, s1, side, gap, { h: topH, rows });
    ctx.indexSolid(s0, s1, side, gap, depth);
    const opt = opts;
    along(s0, s1, step, (k, spacing) => {
      const a = anchor(k, side, gap), b: Basis = [a.r, a.u, a.t];
      // STRAIGHT BOXES ON A BEND (#2204): cap each row at the chord between this
      // station and its neighbours (structures.js:807-821).
      const nb = Math.max(1, Math.round(step / ds));
      const kn = [(k + nb) % n, (k - nb + n) % n].map((kk) => anchor(kk, side, gap));
      const chord = (lat: number) => {
        const p = vadd(a.c, a.r, lat);
        let c = spacing;
        for (const q of kn) {
          const pq = vadd(q.c, q.r, lat);
          c = Math.min(c, Math.hypot(pq[0] - p[0], pq[1] - p[1], pq[2] - p[2]));
        }
        return c;
      };
      // The box's depth also swings into the neighbour (structures.js:822-832).
      const swing = (() => {
        let t = 0;
        for (const q of kn) {
          const dx = q.c[0] - a.c[0], dy = q.c[1] - a.c[1], dz = q.c[2] - a.c[2], dl = Math.hypot(dx, dy, dz) || 1;
          const cos = Math.abs((dx * a.t[0] + dy * a.t[1] + dz * a.t[2]) / dl);
          t = Math.max(t, Math.sqrt(Math.max(0, 1 - cos * cos)) / Math.max(0.2, cos));
        }
        return t;
      })();
      const rowSeg = (back: number) => {
        const half = dep / 2;
        const c = Math.min(spacing, chord(back - half), chord(back + half), chord(back));
        // Past the bend's centre of curvature the row folds onto its neighbour: no row there.
        const l = (c - dep * 0.5 * swing) * 0.98;
        return l < 1.2 ? 0 : l;
      };
      const seg = rowSeg(side * depth / 2);
      if (seg <= 0) return;
      if (rejBox(vadd(vadd(a.c, a.u, topH / 2), a.r, side * depth / 2),
                 [depth, topH, seg], b)) return;
      out._mat = MAT.CONCRETE;
      if (opt.retainer !== false)
        addBox(out, vadd(a.c, a.u, 1.0), [0.9, 2.2, rowSeg(0) || seg], concAlt, b);
      for (let r = 0; r < rows; r++) {
        const back = side * (1.0 + r * dep), up = 1.4 + r * rise;
        const tc = vadd(vadd(a.c, a.r, back), a.u, up);
        const rs = rowSeg(back);
        if (rs <= 0) continue;
        out._mat = MAT.CONCRETE;
        addBox(out, tc, [dep, rise + 0.3, rs], r & 1 ? conc : concAlt, b);
        crowdBand(vadd(tc, a.u, rise * 0.5 + 0.6), b, side, dep * 0.6, 1.1, rs - 1.6,
                  opt.crowd, dens, k * 31.7 + r * 11.3 + side * 7.1);
      }
      const topBack = side * (1.0 + rows * dep);
      const tbSeg = rowSeg(topBack) || seg;                                            // the back wall stands on the outermost arc
      if (opt.backWall !== false) {
        out._mat = MAT.CONCRETE;
        // Take the wall's foot down to the lowest terrain under it (structures.js:861-864).
        const wc = vadd(a.c, a.r, topBack);
        let drop = 0;
        if (typeof terrainYAt === "function") {
          for (const o of [-0.5, 0, 0.5]) {
            const p = vadd(wc, a.t, o * tbSeg), ty = terrainYAt(p[0], p[2]);
            if (ty != null) drop = Math.max(drop, (p[1] - ty) / Math.max(0.5, a.u[1]));
          }
        }
        const wallH = topH + drop;
        addBox(out, vadd(wc, a.u, topH - wallH * 0.5),
               [0.7, wallH, tbSeg], concAlt, b);                                       // plain back wall
      }
      if (opt.cut) {
        out._mat = 0;
        addPrism(out, vadd(vadd(a.c, a.r, topBack), a.u, topH),
                 [6, 3.4, tbSeg], opt.cutCol || [0.52, 0.32, 0.22], b);
      }
      out._mat = 0;
    }, `terrace|${side}|${gap}|${rows}|${rise}|${dep}|${step}`);
  };

  // structures.js:886-927.
  const tieredBowl = (s0: number, s1: number, side: number, gap: number, opts?: TieredBowlOpts | null): void => {
    opts = opts || {};
    const tiers = clamp(Math.round(opts.tiers || 4), 1, 8);
    const tierDepth = opts.tierDepth != null ? opts.tierDepth : 5.6;
    const base = opts.base != null ? opts.base : 3.0;    // first tier's riser height
    const rise = opts.rise != null ? opts.rise : 3.3;    // added per tier
    const shell: readonly RVec3[] = (opts.shell && opts.shell.length === 2) ? opts.shell
      : [[0.57, 0.58, 0.60], [0.51, 0.52, 0.55]];
    const fascia: RVec3 = opts.fascia || [0.93, 0.90, 0.80];
    const dens = opts.density != null ? clamp(opts.density, 0.05, 1) : 0.55;
    const step = opts.step || 8;
    const topH = base + (tiers - 1) * rise + 2.0;
    ctx.noteSpan("tieredBowl", s0, s1, side, gap, { h: topH, tiers });
    ctx.indexSolid(s0, s1, side, gap, tiers * tierDepth + 2);
    const opt = opts;
    along(s0, s1, step, (k, spacing) => {
      const seg = spacing * 0.98;
      for (let t = 0; t < tiers; t++) {
        const a = anchor(k, side, gap + t * tierDepth), b: Basis = [a.r, a.u, a.t];
        const h = base + t * rise;
        if (rejBox(vadd(a.c, a.u, h / 2), [tierDepth * 0.93, h, seg], b)) continue;
        out._mat = MAT.CONCRETE;
        addBox(out, vadd(a.c, a.u, h * 0.5), [tierDepth * 0.93, h, seg],
               t % 2 ? shell[0]! : shell[1]!, b);                                      // riser
        crowdBand(vadd(a.c, a.u, h + 0.85), b, side, tierDepth * 0.8, 1.6, seg - 1.0,
                  opt.crowd, dens, k * 3.1 + t * 31.7 + side * 2.3);
        out._mat = 0;
        addBox(out, vadd(a.c, a.u, h + 1.85), [tierDepth * 0.86, 0.32, seg + 0.5],
               fascia, b);                                                             // fascia lip
      }
      if (opt.roof) {
        const aR = anchor(k, side, gap + (tiers - 0.5) * tierDepth);
        const bR: Basis = [aR.r, aR.u, aR.t];
        const ry = base + (tiers - 1) * rise + 2.6;
        if (!rejBox(vadd(aR.c, aR.u, ry), [tierDepth * 1.3, 0.5, seg + 1], bR)) {
          out._mat = MAT.METAL;
          addBox(out, vadd(aR.c, aR.u, ry), [tierDepth * 1.3, 0.5, seg + 1],
                 opt.roofCol || [0.19, 0.19, 0.23], bR);
        }
      }
      out._mat = 0;
    }, `bowl|${side}|${gap}|${tiers}|${rise}|${tierDepth}|${step}`);
  };

  // Seven-segment digit at a world point. structures.js:929-937.
  const signDigit = (c: RVec3, r: RVec3, u: RVec3, t: RVec3, w: number, h: number, proud: number, col: RVec3, digit: number): void => {
    const segs = (SIGN_DIGIT[digit] ?? SIGN_DIGIT[0])!;
    const base = vadd(c, r, proud);
    for (const name of segs) {
      const [x0, x1, y0, y1] = SIGN_SEG[name]!;
      const cc = vadd(vadd(base, t, (x0 + x1) / 2 * w - w / 2), u, (y0 + y1) / 2 * h - h / 2);
      addBox(out, cc, [0.03, (y1 - y0) * h, (x1 - x0) * w], col, [r, u, t]);
    }
  };
  // structures.js:938-981: speed disc / braking board / corner number board.
  const signBoard = (k: number, side: number, gap: number, kind: string, value: number): void => {
    const p = anchor(k, side, gap), b: Basis = [p.r, p.u, p.t];
    if (onTrack(p.c[0], p.c[2], 1.5)) {
      ctx.noteSuppressed("signBoard", `signBoard SUPPRESSED at k=${k} side=${side}: gap=${gap}`);
      return;
    }
    ctx.note("signBoard", [p.c[0], p.c[1] + 1, p.c[2]], [2.5, 2, 0.3], { k, side, board: kind, value });
    const postH = 1.35;
    const proud = -side * 0.05;   // segment relief toward the viewer
    addCyl(out, vadd(p.c, p.u, -0.3), 0.06, postH + 0.3, [0.55, 0.55, 0.58], 4, b);   // base sunk
    if (kind === "speed") {
      const R = 0.52, cc = vadd(p.c, p.u, postH + R);
      const fwd: RVec3 = [-side * p.r[0], -side * p.r[1], -side * p.r[2]];
      const db: Basis = [p.u, fwd, p.t];
      // The digits are skipped with a culled disc (structures.js:952-954).
      if (addCyl(out, cc, R, 0.05, [0.85, 0.16, 0.14], 12, db) === false) return;       // red rim disc
      if (addCyl(out, vadd(cc, fwd, 0.02), R * 0.80, 0.05, [0.95, 0.95, 0.93], 12, db) === false) return;   // white face
      const digs = String(Math.max(10, Math.min(99, value || 80))).split("").map(Number);
      digs.forEach((d, i) => {
        const dc = vadd(cc, p.t, (i - (digs.length - 1) / 2) * 0.36);
        signDigit(dc, p.r, p.u, p.t, 0.34, 0.62, -side * 0.06, [0.10, 0.10, 0.12], d);
      });
    } else if (kind === "braking") {
      const w2 = 1.3, h2 = 0.9, cc = vadd(p.c, p.u, postH + h2 / 2);
      if (addBox(out, cc, [0.05, h2, w2], [0.92, 0.92, 0.90], b) === false) return;   // white panel face
      const nStripes = Math.max(1, Math.min(3, value || 2));
      const diagU = norm([p.u[0] + p.t[0], p.u[1] + p.t[1], p.u[2] + p.t[2]]);
      for (let i = 0; i < nStripes; i++) {
        const sx = (i - (nStripes - 1) / 2) * (w2 / (nStripes + 0.4));
        const sc = vadd(vadd(cc, p.t, sx), p.r, proud);
        addBox(out, sc, [0.02, h2 * 1.15, 0.16], [0.85, 0.15, 0.13], [p.r, diagU, p.t]);
      }
    } else {   // "corner" number board
      const w2 = 1.0, h2 = 0.85, cc = vadd(p.c, p.u, postH + h2 / 2);
      if (addBox(out, cc, [0.05, h2, w2], [0.92, 0.92, 0.90], b) === false) return;
      const digs = String(Math.max(1, Math.min(99, value || 1))).split("").map(Number);
      digs.forEach((d, i) => {
        const dc = vadd(cc, p.t, (i - (digs.length - 1) / 2) * 0.38);
        signDigit(dc, p.r, p.u, p.t, 0.36, 0.58, proud, [0.10, 0.10, 0.12], d);
      });
    }
  };
  // structures.js:982-1048.
  function ferrisWheel(k: number, side: number, dist: number, radius: number): void {
    const r: RVec3 = [track.rx[k]!, track.ry[k]!, track.rz[k]!];
    const tl = Math.hypot(track.tx[k]!, track.tz[k]!) || 1;
    const tn: RVec3 = [track.tx[k]! / tl, 0, track.tz[k]! / tl];   // horizontal tangent
    const o = side * (hw[k]! + dist);
    const cx = px[k]! + r[0] * o, cz = pz[k]! + r[2] * o;
    // Prefer the rendered terrain ribbon for the foot (structures.js:988-990).
    const ty = typeof terrainYAt === "function" ? terrainYAt(cx, cz) : null;
    const gy = ty != null ? ty : groundYAt(k, dist);
    const hubY = gy + radius + 5;
    const hub: RVec3 = [cx, hubY, cz];
    for (const lo of [-3, 3]) {                            // support legs
      addBox(out, [cx + tn[0] * lo, gy + (hubY - gy) / 2 - 0.5, cz + tn[2] * lo],
             [1.6, hubY - gy + 0.4, 1.6], [0.32, 0.33, 0.38]);
    }
    addBox(out, hub, [3, 3, 3], [0.3, 0.3, 0.34]);         // hub
    const seg = 16;
    // NIGHT, not def.night: this BUILD's value (structures.js:1001-1007).
    const wheelCol: RVec3 = NIGHT ? [0.30, 0.31, 0.4] : [0.62, 0.63, 0.68];
    const rim: Vec3[] = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      rim.push([hub[0] + tn[0] * ca * radius, hub[1] + sa * radius, hub[2] + tn[2] * ca * radius]);
    }
    // `ax` shifts the member along the wheel AXIS (structures.js:1014-1020).
    const strut = (p0: RVec3, p1: RVec3, thick: number, col: RVec3, ax: number) => {
      const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]] as const;
      const L = Math.hypot(d[0], d[1], d[2]) || 1;
      const up: RVec3 = [d[0] / L, d[1] / L, d[2] / L];
      let rr: RVec3 = norm(cross(up, tn)); if (!isFinite(rr[0])) rr = [1, 0, 0];
      const ff = norm(cross(up, rr));
      const o = ax || 0;
      addBox(out, [(p0[0] + p1[0]) / 2 + tn[0] * o, (p0[1] + p1[1]) / 2 + tn[1] * o, (p0[2] + p1[2]) / 2 + tn[2] * o],
             [thick, L, thick], col, [rr, up, ff]);
    };
    const HUB_R = 1.7;
    for (let i = 0; i < seg; i++) {
      const ri = rim[i]!;
      const d = [ri[0] - hub[0], ri[1] - hub[1], ri[2] - hub[2]] as const;
      const L = Math.hypot(d[0], d[1], d[2]) || 1;
      const root: RVec3 = [hub[0] + d[0] / L * HUB_R, hub[1] + d[1] / L * HUB_R,
                           hub[2] + d[2] / L * HUB_R];
      strut(root, ri, 0.28, wheelCol, i % 2 ? 0.06 : -0.06);                // spoke
      strut(ri, rim[(i + 1) % seg]!, 0.34, wheelCol, i % 2 ? -0.06 : 0.06);  // rim segment
    }
    for (let i = 0; i < seg; i++) {                        // cabins hung off the rim
      const cab: RVec3 = NIGHT
        ? ([[0.95, 0.2, 0.5], [0.2, 0.85, 0.95], [0.95, 0.8, 0.2]] as const)[i % 3]!
        : (i % 2 ? [0.9, 0.25, 0.25] : [0.95, 0.95, 0.98]);
      const ri = rim[i]!;
      addBox(out, [ri[0], ri[1] - 1.5, ri[2]], [2.4, 2.2, 2.4], cab);
    }
    // solid base (legs + hub footprint) → stop the car before it on open tracks
    blockAt(k, side, dist - 0.8, 4);
  }

  return { along, wall, fence, guardrail, tyreWall, gantry, flagQuad,
           marshalPost, cameraTower, sponsorHoarding, signDigit, signBoard,
           ferrisWheel,
           bleacher, scaffoldStand, terrace, tieredBowl };
}
