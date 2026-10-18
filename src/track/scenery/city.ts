/**
 * SceneryCity: the city/building band of the buildProps composite-model
 * toolkit: the shared neonFacade curtain wall, the building()/neonTower()
 * massing, neon signs, street lamps, cityFront rows, houses, motorhomes,
 * towers and billboards.
 *
 * Port of f1-game js/track/scenery/city.js:1-930 (`SceneryCity`). Verbatim:
 * float math keeps f1-game's operation order; the code is kept line-for-line
 * close so the two can be diffed. Differences from the IIFE:
 * - `Log.info` (city.js:20) and the `Log.warn` swapped-dimensions trace
 *   (city.js:167-168) are dropped (no effect on output).
 * - `TrackGeom.MIN_SEP` (city.js:638) comes from the injected `core`.
 * - `TrackGraph.NODE_COLOR` is imported from ./graph.
 */
import type {
  Basis, MatName, RVec3, SceneryAnchor, SceneryApi, SceneryBuffer, SceneryDef, SeatKit,
} from "../../contracts/scenery";
import type { Vec3 } from "../../contracts/track";
import type { SceneryCore } from "./core";
import { HOUSE_ROOFS, HOUSE_WALLS, MOTORHOME_BODY, WINTINTS } from "./data";
import { NODE_COLOR } from "./graph";
import type { GraphMeta, GraphPlace, Recorder } from "./graph";

/** The op recorder `instance()` hands a model's build (graph.ts `Recorder`). */
export type SceneryRecorder = Recorder;

/** An instance placement (graph.ts `GraphPlace`). */
export type InstancePlace = GraphPlace;

/** `instance()` meta (graph.ts `GraphMeta`). */
export type InstanceMeta = GraphMeta;

/** `instance()` opts: build-props.js:563-575. */
export interface InstanceOpts {
  readonly buf?: SceneryBuffer;
  readonly unguarded?: boolean;
  readonly roundNormals?: boolean;
}

/** The ctx members SceneryCity reads (city.js:15-19 plus the `ctx.*` calls). */
export interface CityCtx {
  readonly out: SceneryBuffer;
  readonly glassBuf: SceneryBuffer;
  readonly def: Pick<SceneryDef, "id" | "street">;
  readonly theme: string | undefined;
  readonly NIGHT: boolean;
  readonly MAT: { readonly [M in MatName]: number };
  /** build-props.js:232: mobile LOD count, floored. */
  lod(nn: number, floor: number): number;
  readonly seat: Pick<SeatKit, "prism">;
  readonly addBox: SceneryApi["addBox"];
  readonly addCyl: SceneryApi["addCyl"];
  readonly addCone: SceneryApi["addCone"];
  readonly addFrustum: SceneryApi["addFrustum"];
  readonly addPrism: SceneryApi["addPrism"];
  readonly addPyramid: SceneryApi["addPyramid"];
  /** guards.js:129: the oriented footprint touches tarmac. */
  rejBox(c: RVec3, sz: RVec3, basis: Basis): boolean;
  /** build-props.js:595. */
  blockAt(k: number, side: number, innerGap: number, halfM?: number): void;
  readonly onTrack: SceneryApi["onTrack"];
  readonly hash: SceneryApi["hash"];
  readonly vadd: SceneryApi["vadd"];
  /** build-props.js:1356-1360. */
  kitOf(family: string, fallback: string): string;
  readonly anchor: SceneryApi["anchor"];
  readonly along: SceneryApi["along"];
  /** build-props.js:1012. */
  massBlocked(c: RVec3, w: number, d: number, b: Basis, shrink?: number): boolean;
  /** build-props.js:1039. */
  massAdd(c: RVec3, w: number, d: number, b: Basis): void;
  readonly terrainYAt: SceneryApi["terrainYAt"];
  /** nature.js:380. */
  treeInFootprint(c: RVec3, w: number, h: number, d: number, b: Basis): boolean;
  /** build-props.js:570: primitives that survived the guards (0 = none). */
  instance(
    key: string, place: InstancePlace, build: (rec: SceneryRecorder) => void,
    meta?: InstanceMeta, opts?: InstanceOpts,
  ): number;
  /** build-props.js:299. */
  noteSuppressed(kind: string, msg: string): void;
  /** build-props.js:332. TODO(scenery): type the prop record (build-props.js:334). */
  note(kind: string, c: RVec3, size: RVec3, extra?: { readonly [key: string]: unknown }): unknown;
  /** build-props.js:1049. */
  reserveEmittedSolid(buf: SceneryBuffer, start: number, basis: Basis): boolean;
}

/** building() opts (city.js:161-217). */
export interface BuildingOpts {
  readonly _kit?: boolean | undefined;
  readonly wall?: RVec3 | undefined;
  readonly window?: RVec3 | undefined;
  readonly windowCol?: RVec3 | undefined;
  readonly floor?: number | undefined;
  readonly lit?: boolean | undefined;
  readonly arch?: string | undefined;
  readonly kind?: string | undefined;
  readonly neon?: number | null | undefined;
}

/** neonTower() tone (city.js:196-199). */
export interface TowerTone {
  readonly n?: RVec3 | undefined;
  readonly d?: RVec3 | undefined;
}

/** cityFront() opts (city.js:719-728). */
export interface CityFrontOpts {
  readonly minH?: number | null | undefined;
  readonly maxH?: number | null | undefined;
  readonly depth?: number | null | undefined;
  readonly lit?: boolean | undefined;
  readonly palette?: readonly RVec3[] | undefined;
  readonly step?: number | undefined;
  readonly floor?: number | undefined;
  readonly windowCol?: RVec3 | undefined;
}

/** house() opts (city.js:756-783). */
export interface HouseOpts {
  readonly wall?: RVec3 | undefined;
  readonly roof?: RVec3 | undefined;
  readonly roofType?: string | undefined;
  readonly lit?: boolean | undefined;
  readonly window?: RVec3 | undefined;
}

/** motorhome() opts (city.js:789-815). */
export interface MotorhomeOpts {
  readonly wall?: RVec3 | undefined;
  readonly accent?: RVec3 | undefined;
  readonly lit?: boolean | undefined;
  readonly window?: RVec3 | undefined;
  readonly awning?: RVec3 | undefined;
}

/** tower() opts (city.js:825-843). */
export interface CityTowerOpts {
  readonly col?: RVec3 | undefined;
  readonly seg?: number | undefined;
  readonly glassCol?: RVec3 | undefined;
  readonly deckCol?: RVec3 | undefined;
  readonly cap?: boolean | undefined;
  readonly capCol?: RVec3 | undefined;
  readonly mast?: boolean | number | undefined;
}

/** billboard() opts (city.js:846-860). */
export interface BillboardOpts {
  readonly style?: string | undefined;
  readonly postCol?: RVec3 | undefined;
}

type NeonTowerArgs = [
  k: number, side: number, dist: number, w: number, h: number, d: number,
  neon: RVec3, kind: string, tone: TowerTone | null | undefined, neonAmt?: number | null,
];

/** The API city.js:924-925 returns (merged into ctx by build-props.js:1364). */
export interface CityApi {
  neonFacade(mid: RVec3, bb: Basis, side: number, sw: number, sh: number, sd: number,
    neon: RVec3, seed: number, neonAmt: number): void;
  building(k: number, side: number, gap: number, w: number, h: number, d: number, opts?: BuildingOpts | null): void;
  neonTower(...args: NeonTowerArgs): void;
  neonSign(k: number, side: number, dist: number, h: number, neon: RVec3): void;
  streetLamp(k: number, side: number, dist: number, head: RVec3, h: number, lstyle?: string | null): void;
  cityFront(s0: number, s1: number, side: number, gap: number, opts?: CityFrontOpts | null): void;
  house(k: number, side: number, gap: number, w: number, h: number, d: number, opts?: HouseOpts | null): void;
  motorhome(k: number, side: number, gap: number, w: number, h: number, d: number, opts?: MotorhomeOpts | null): void;
  tower(k: number, side: number, dist: number, baseW: number, h: number, opts?: CityTowerOpts | null): void;
  billboard(k: number, side: number, gap: number, w: number, h: number, col?: RVec3 | null, opts?: BillboardOpts | null): void;
}

/** A unit-box facade detail spec (city.js:52-53). */
interface DetailSpec extends InstancePlace {
  readonly s: RVec3;
  readonly col: RVec3;
}

const UNIT_BOX = "unit-box";
const unitBox = (rec: SceneryRecorder) => rec.box([0, 0, 0], [1, 1, 1], NODE_COLOR);
// city.js:7-12: a wall mass carries its facade material INTO the shared model
// (H27); one model per material id.
const massBox = (mat: number) => (rec: SceneryRecorder) => { rec.mat(mat); unitBox(rec); };

const basisOf = (a: SceneryAnchor): Basis => [a.r, a.u, a.t];

export function create(ctx: CityCtx, core: SceneryCore): CityApi {
  const { out, glassBuf, def, theme, NIGHT, MAT, lod,
          seat,
          addBox, addCyl, addCone, addFrustum, addPrism, addPyramid,
          rejBox, blockAt, onTrack, hash, vadd, kitOf,
          anchor, along, massBlocked, massAdd, terrainYAt, treeInFootprint } = ctx;

  // city.js:23-50 sunk(): is a facade DETAIL box wholly underground (its top
  // face's four corners + centre under the rendered terrain)? `bb` is the
  // [r,u,t] basis, `s` the size along it.
  const TOP_P: readonly (readonly [number, number])[] = [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]];   // centre first: most panes exit there
  const sunk = (o: RVec3, bb: Basis, s: RVec3): boolean => {
    const r = bb[0], u = bb[1], t = bb[2];
    const hu = s[1] / 2;
    const tx = o[0] + u[0] * hu, ty = o[1] + u[1] * hu, tz = o[2] + u[2] * hu;
    let under = 0;
    for (const k of TOP_P) {
      const a = k[0] * s[0] / 2, c = k[1] * s[2] / 2;
      const g = terrainYAt(tx + r[0] * a + t[0] * c, tz + r[2] * a + t[2] * c);
      if (g == null) continue;
      if (g <= ty + r[1] * a + t[1] * c) return false;
      under++;
    }
    return under >= 2;
  };
  // A unit-box facade detail, skipped when sunk() says it is inside the hill.
  const detail = (spec: DetailSpec, meta: InstanceMeta, opt?: InstanceOpts): number =>
    sunk(spec.o, [spec.r, spec.u, spec.t], spec.s) ? 0 : ctx.instance(UNIT_BOX, spec, unitBox, meta, opt);

  // city.js:55-63.
  const facadeMat = (rgb: RVec3): number => {
    const r = rgb[0], g = rgb[1], b = rgb[2];
    const luma = (r + g + b) / 3;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    const warm = r - b;
    if (r > g + 0.16 && warm > 0.12 && chroma > 0.14 && luma < 0.70) return MAT.BRICK;
    if (luma > 0.55 && chroma < 0.28 && warm > -0.04) return MAT.STONE;
    return MAT.CONCRETE;
  };

  // city.js:65-160.
  const neonFacade = (mid: RVec3, bb: Basis, side: number, sw: number, sh: number, sd: number,
    neon: RVec3, seed: number, neonAmt: number): void => {
    const u = bb[1];
    const frameCol: RVec3 = [0.12, 0.12, 0.15];                       // dark structural frame
    const dark: RVec3 = [0.035, 0.035, 0.055];                        // unlit glass pane
    const warm: RVec3 = [1.0, 0.80, 0.46];
    const nc: RVec3 = [neon[0] * 0.95, neon[1] * 0.95, neon[2] * 0.95];
    const litShare = 0.20 + neonAmt * 0.08, neonShare = neonAmt * 0.7;
    const rows = lod(Math.max(4, Math.min(10, Math.round(sh / 4.4))), 3);   // perf: coarser window grid; mobile LOD via lod()
    const fh = sh / rows, frameT = 0.30, railH = Math.max(0.4, fh * 0.24), winH = Math.max(0.5, fh - railH);
    const drawFace = (nAxis: 0 | 2, nSign: number, nHalf: number, wAxis: 0 | 2, faceW: number, sOff: number, simple: boolean) => {
      const nVec = bb[nAxis], wVec = bb[wAxis];
      // Spend the secondary-face detail budget on nearby venue facilities.
      const cols = simple ? 2 : lod(Math.max(2, Math.min(6, Math.round(faceW / 3.3))), 2);
      const rowN = simple ? lod(Math.max(2, Math.min(6, Math.round(sh / 6.4))), 2) : rows;
      const fhh = sh / rowN, winHH = Math.max(0.5, fhh - railH);
      const fBase = vadd(mid, nVec, nSign * (nHalf + 0.34));
      const mBase = vadd(mid, nVec, nSign * (nHalf + 0.29));
      const nBase = vadd(mid, nVec, nSign * (nHalf + 0.40));
      const gBase = vadd(mid, nVec, nSign * (nHalf + 0.05 + 0.04));
      const dim = (thin: number, hgt: number, wid: number): RVec3 => { const a: Vec3 = [0, 0, 0]; a[nAxis] = thin; a[1] = hgt; a[wAxis] = wid; return a; };
      out._mat = MAT.METAL;
      // city.js:86-93: every other rail, i=0 skipped (coplanar with the
      // section below's top rail on stacked massings).
      if (!simple) for (let i = 2; i <= rowN; i += 2)
        detail({ o: vadd(fBase, u, (i / rowN - 0.5) * sh), r: bb[0], u: bb[1], t: bb[2],
            s: dim(frameT, railH, faceW * 1.005), col: frameCol },
          { kind: "facadeRail" });
      for (let c = 0; c < cols; c++) {
        const cx = (-0.5 + (c + 0.5) / cols) * faceW;
        for (let ri = 0; ri < rowN; ri++) {
          const ry = (-0.5 + (ri + 0.5) / rowN) * sh;
          let col = dark, lit = false;
          if (hash(seed + sOff + c * 12.9 + ri * 7.3) < litShare) {
            lit = true;
            const tw = 0.65 + hash(seed + sOff + c * 5.5 + ri * 2.2) * 0.5;
            col = hash(seed + sOff + c * 3.1 + ri * 1.7) < neonShare
              ? [nc[0] * tw, nc[1] * tw, nc[2] * tw] : [warm[0] * tw, warm[1] * tw, warm[2] * tw];
          }
          const toGlass = !lit && !simple;
          if (toGlass) glassBuf._mat = MAT.GLASS; else out._mat = 0;   // lit panes stay untextured (pure emissive read)
          detail({ o: vadd(vadd(gBase, wVec, cx), u, ry),
              r: bb[0], u: bb[1], t: bb[2],
              s: dim(0.08, winHH, (faceW / cols) * 0.82),
              col },
            { kind: "windowPane" },
            { buf: toGlass ? glassBuf : out });
          if (toGlass) glassBuf._mat = 0;
        }
      }
      out._mat = MAT.METAL;
      if (simple) { out._mat = 0; return; }
      const nm = Math.max(1, Math.min(3, cols - 1));   // perf: fewer mullions (was 5)
      for (let c = 1; c <= nm; c++)
        detail({ o: vadd(mBase, wVec, (-0.5 + c / (nm + 1)) * faceW), r: bb[0], u: bb[1], t: bb[2],
            s: dim(frameT, sh, 0.4), col: frameCol },
          { kind: "facadeMullion" });
      if (neonAmt > 0.3) {
        const ST = Math.min(0.4, faceW * 0.04);
        for (const dr of [-1, 1])
          detail({ o: vadd(nBase, wVec, dr * faceW * 0.5), r: bb[0], u: bb[1], t: bb[2],
              s: dim(frameT * 1.05, sh * 0.96, ST), col: nc },
            { kind: "facadeNeon" });
        // city.js:133-148: step the crown band down clear of any rail face
        // it would share a plane with.
        const bandH = Math.min(0.5, sh * 0.018);
        let bandC = sh * 0.48;
        const clash = (c: number) => {
          for (let i = 2; i <= rowN; i += 2) {
            const ry = (i / rowN - 0.5) * sh;
            if (Math.abs((c - bandH / 2) - (ry - railH / 2)) < 0.05 ||
                Math.abs((c + bandH / 2) - (ry + railH / 2)) < 0.05) return true;
          }
          return false;
        };
        for (let tries = 0; tries < 3 && clash(bandC); tries++) bandC -= 0.08;
        detail({ o: vadd(nBase, u, bandC), r: bb[0], u: bb[1], t: bb[2],
            s: dim(frameT * 1.1, bandH, faceW), col: nc },
          { kind: "facadeNeon" });
      }
      out._mat = 0;
    };
    drawFace(0, -side, sw / 2, 2, sd, 0, false);   // track-facing facade: full detail
    drawFace(2, 1, sd / 2, 0, sw, 137, true);      // +t side: simple
    drawFace(2, -1, sd / 2, 0, sw, 311, true);     // -t side: simple
    // No back-face panes: the solid UNIT_BOX mass already closes all four walls.
  };

  // city.js:161-425.
  const building = (k: number, side: number, gap: number, w: number, h: number, d: number, opts?: BuildingOpts | null): void => {
    opts = opts || {};
    // city.js:163-168: the swapped-argument Log.warn is dropped (no output).
    const dist = gap + w / 2;
    const p = anchor(k, side, dist), b = basisOf(p);
    // city.js:171-178: rejBox runs the full oriented-footprint Minkowski test;
    // clearMargin pads the street-circuit barrier allowance into the box.
    const clearMargin = def.street ? 3.0 : 1.2;
    // city.js:179-187: yield to a mass already standing here, but keep the
    // driving boundary.
    if (massBlocked(p.c, w, d, b, 0.82)) { blockAt(k, side, gap, d / 2); return; }
    if (rejBox(p.c, [w + clearMargin * 2, h, d + clearMargin * 2], b)) {
      ctx.noteSuppressed("building", `building SUPPRESSED at k=${k} side=${side}: gap=${gap} w=${w} (footprint over track)`);
      return;
    }
    ctx.note("building", [p.c[0], p.c[1] + h / 2, p.c[2]], [w, h, d], { k, side });
    if (opts.kind) {
      const wl = opts.wall ? (opts.wall[0] + opts.wall[1] + opts.wall[2]) / 3 : 1;
      const tone: TowerTone = {
        n: opts.wall || [0.14, 0.14, 0.17],
        d: (opts.wall && wl > 0.45) ? opts.wall : [0.46, 0.46, 0.45],
      };
      neonTower(k, side, dist, w, h, d,
                opts.windowCol || opts.window || [1.0, 0.88, 0.55],
                opts.kind, tone,
                opts.neon != null ? opts.neon
                                  : (theme === "street_night" ? 0.85 : 0.32));
      return;
    }
    const nightLit = NIGHT && opts.lit !== false;
    let body: RVec3 = opts.wall || [0.62, 0.64, 0.68];
    if (nightLit) body = [Math.max(body[0], 0.26), Math.max(body[1], 0.24), Math.max(body[2], 0.30)];
    const winBase: RVec3 = opts.windowCol || opts.window || [1.0, 0.88, 0.55];
    const HDR = 1.55;
    const litGlass: RVec3 = [winBase[0] * HDR, winBase[1] * HDR, winBase[2] * HDR];
    const dayGlass: RVec3 = opts.window
      ? [Math.min(0.9, opts.window[0] * 0.25 + 0.30), Math.min(0.9, opts.window[1] * 0.25 + 0.33), Math.min(0.9, opts.window[2] * 0.25 + 0.38)]
      : [0.34, 0.40, 0.50];
    const glass = nightLit ? litGlass : dayGlass;
    const floorH = opts.floor || 4.0;
    const section = (yBase: number, sw: number, sh: number, sd: number): boolean => {
      if (nightLit) {
        // city.js:220-222: NIGHT = a dark neutral-grey concrete mass with
        // thin-pinstripe detailing on top.
        const lum = (body[0] + body[1] + body[2]) / 3;
        const bv = lum > 0.4 ? 0.22 : 0.15;
        const bodyTint: RVec3 = [bv, bv, bv * 1.12];
        const ok = ctx.instance(UNIT_BOX,
          { o: vadd(p.c, p.u, yBase + sh / 2), r: p.r, u: p.u, t: p.t, s: [sw, sh, sd], col: bodyTint },
          unitBox, { kind: "buildingMass", k, side }) > 0;
        if (ok === false) return false;
        neonFacade(vadd(p.c, p.u, yBase + sh / 2), b, side, sw, sh, sd, winBase, k * 7.1 + side * 3.3, theme === "street_night" ? 0.85 : 0.32);
        return ok;
      }
      const wallLuma = (body[0] + body[1] + body[2]) / 3;
      const cv = hash(k * 1.7 + side * 2.9);
      const dayWall: RVec3 = wallLuma > 0.45
        ? [body[0] * 0.78, body[1] * 0.78, body[2] * 0.78]
        : [0.42 + cv * 0.12, 0.42 + cv * 0.11, 0.41 + cv * 0.10];
      const wmat = facadeMat(dayWall);
      out._mat = wmat; glassBuf._mat = MAT.GLASS;
      const ok = ctx.instance(UNIT_BOX + ":" + wmat,                                      // solid wall mass
        { o: vadd(p.c, p.u, yBase + sh / 2), r: p.r, u: p.u, t: p.t, s: [sw, sh, sd], col: dayWall },
        massBox(wmat), { kind: "buildingMass", k, side }) > 0;
      // city.js:243-247: DAY must match NIGHT: a rejected wall mass must not
      // leave orphan facade rails / panes / mullions.
      if (ok === false) { out._mat = 0; glassBuf._mat = 0; return false; }
      const rows = Math.max(2, Math.min(8, Math.round(sh / floorH)));
      const fh = sh / rows;
      const dayMull: RVec3 = [dayWall[0] * 0.82, dayWall[1] * 0.82, dayWall[2] * 0.82];
      const frameOut = 0.38;
      const glassOut = 0.05;
      const frameT   = 0.30;
      const glassT   = 0.08;
      const fR = -side * (sw / 2 + frameOut);
      const gR = -side * (sw / 2 + glassOut);
      const fBase = vadd(p.c, p.r, fR);
      const mBase = vadd(p.c, p.r, -side * (sw / 2 + frameOut - 0.05));
      const gBase = vadd(p.c, p.r, gR);
      const railH = Math.max(0.45, fh * 0.28);
      for (let r = 0; r <= rows; r++) {
        detail({ o: vadd(fBase, p.u, yBase + r * fh), r: p.r, u: p.u, t: p.t, s: [frameT, railH, sd], col: dayMull },
          { kind: "facadeRail", k, side });
      }
      const winH = Math.max(0.6, fh - railH);
      const dMed = dayWall[0] > 0.6 && dayWall[0] > dayWall[2] + 0.08;
      for (let r = 0; r < rows; r++) {
        const ry01 = (r + 0.5) / rows;
        if (dMed) {
          out._mat = MAT.GLASS;
          detail({ o: vadd(gBase, p.u, yBase + (r + 0.5) * fh), r: p.r, u: p.u, t: p.t,
              s: [glassT, winH, sd * 0.94],
              col: [dayWall[0] * 0.34, dayWall[1] * 0.30, dayWall[2] * 0.26] },
            { kind: "windowPane", k, side });
          out._mat = wmat;
        } else {
          const t01 = 0.42 + ry01 * 0.16;
          detail({ o: vadd(gBase, p.u, yBase + (r + 0.5) * fh), r: p.r, u: p.u, t: p.t,
              s: [glassT, winH, sd * 0.94], col: [t01 * 0.40, t01 * 0.47, t01 * 0.62] },
            { kind: "windowPane", k, side }, { buf: glassBuf });
        }
      }
      const nm = Math.max(2, Math.min(6, Math.round(sd / 5)));
      for (let c = 1; c <= nm; c++) {
        const off = -sd / 2 + (c / (nm + 1)) * sd;
        // city.js:287-291: mullions stop 4 cm under the roof line and 4 cm
        // over the base.
        detail({ o: vadd(vadd(mBase, p.u, yBase + sh / 2), p.t, off), r: p.r, u: p.u, t: p.t,
            s: [frameT, sh - 0.08, 0.5], col: dayMull },
          { kind: "facadeMullion", k, side });
      }
      const nmR = sw > 14 ? (sw > 22 ? 3 : 2) : 1;
      for (let c = 1; c <= nmR; c++) {
        const off = -sw / 2 + (c / (nmR + 1)) * sw;
        detail({ o: vadd(vadd(p.c, p.u, yBase + sh / 2), p.r, off), r: p.r, u: p.u, t: p.t,
            s: [0.5, sh - 0.08, sd * 1.02], col: dayMull },
          { kind: "facadeMullion", k, side });
      }
      out._mat = 0; glassBuf._mat = 0;
      return ok;
    };
    // Ground-floor plinth, grounded but never near-black (day) / glows (night).
    const plH = Math.min(3.2, h * 0.14);
    const plinth: RVec3 = nightLit ? [body[0] * 0.8, body[1] * 0.8, body[2] * 0.9]
                                   : [Math.max(body[0] * 1.2, 0.40), Math.max(body[1] * 1.2, 0.40), Math.max(body[2] * 1.2, 0.44)];
    // city.js:310-316: the plinth's overhang floored clear of the panes.
    const plOut = Math.max(0.22, w * 0.01), pdOut = Math.max(0.22, d * 0.01);
    // city.js:317-321: the plinth's bottom sits PL_SINK under the base.
    const PL_SINK = 0.05;
    addBox(out, vadd(p.c, p.u, (plH - PL_SINK) / 2), [w + 2 * plOut, plH + PL_SINK, d + 2 * pdOut], plinth, b);
    // city.js:323-325: ground-floor entrance on the trackside face.
    if (!nightLit && d >= 6 && w >= 5) {
      const doorCol: RVec3 = [plinth[0] * 0.45, plinth[1] * 0.42, plinth[2] * 0.48];
      const doorH = Math.min(2.6, plH * 0.92 + 1.4);
      const doorW = Math.min(1.8, d * 0.22);
      const faceR = -side * (w / 2 + 0.06);
      const doorC = vadd(vadd(p.c, p.r, faceR), p.u, doorH / 2);
      addBox(out, doorC, [0.18, doorH, doorW], doorCol, b);
      // Awning / canopy proud of the facade above the door.
      const awnCol: RVec3 = [plinth[0] * 0.72, plinth[1] * 0.72, plinth[2] * 0.74];
      addBox(out,
        vadd(vadd(p.c, p.r, -side * (w / 2 + 0.55)), p.u, doorH + 0.15),
        [1.1, 0.14, doorW + 1.2], awnCol, b);
    }
    // city.js:339-345: archetype: tapered + individually-crowned forms.
    const crownCol: RVec3 = nightLit ? [glass[0] * 0.30, glass[1] * 0.30, glass[2] * 0.32]
                                     : [Math.max(body[0] * 1.1, 0.42), Math.max(body[1] * 1.1, 0.42), Math.max(body[2] * 1.1, 0.44)];
    const t = hash(k * 4.1 + side * 2.7);
    const arch = opts.arch || (h < 20 ? "flat"
                              : h < 40 ? (t < 0.5 ? "flat" : "taper")
                              : (t < 0.30 ? "setback" : t < 0.64 ? "taper" : "spire"));
    let topY = h, topW = w, topD = d;
    const diag = Math.max(w, d);
    if (arch === "flat") {
      if (section(0, w, h, d) === false) return;
    } else if (arch === "setback") {
      const h1 = h * 0.55, collar = h * 0.05;
      if (section(0, w, h1, d) === false) return;
      addFrustum(out, vadd(p.c, p.u, h1), diag * 0.5, diag * 0.40, collar, crownCol, 8, b);
      // Upper storey rejected → drop crown/cap dependents (same atomic rule).
      if (section(h1 + collar, w * 0.72, h - h1 - collar, d * 0.72) === false) return;
      topW = w * 0.72; topD = d * 0.72;
    } else if (arch === "taper") {
      const bh = h * 0.90;
      if (section(0, w, bh, d) === false) return;
      addFrustum(out, vadd(p.c, p.u, bh), diag * 0.5, diag * 0.33, h - bh, crownCol, 8, b);
      addCyl(out, vadd(p.c, p.u, bh + (h - bh) * 0.4), diag * 0.40, (h - bh) * 0.16, glass, 8, b);
      topW = w * 0.5; topD = d * 0.5; topY = h;
    } else { // spire: windowed shaft → a short tapered cap → a tall lit spire
      const bh = h * 0.86, crownH = h * 0.10;
      if (section(0, w, bh, d) === false) return;
      addFrustum(out, vadd(p.c, p.u, bh), diag * 0.5, diag * 0.30, crownH, crownCol, 8, b);
      topY = bh + crownH; topW = w * 0.36; topD = d * 0.36;
    }
    {
      const capR = Math.max(topW, topD) * 0.5, capH = Math.min(3.5, h * 0.07 + 1);
      addFrustum(out, vadd(p.c, p.u, topY), capR, capR * 0.45, capH, crownCol, 6, b);
      topY += capH;
      // city.js:379-380: low parapet lip around flat/short crowns.
      if (!nightLit && arch === "flat" && h < 28) {
        const rim: RVec3 = [crownCol[0] * 0.88, crownCol[1] * 0.88, crownCol[2] * 0.90];
        addBox(out, vadd(p.c, p.u, topY - capH + 0.2),
               [topW * 1.02, 0.45, topD * 1.02], rim, b);
      }
      const rt = hash(k * 3.3 + side * 1.9);
      if (h > 30 && rt < 0.58) {
        // slim spire/mast — taller on taller towers; lit tip beacon at night
        const spH = 4 + hash(k * 5.1 + side) * Math.min(20, h * 0.26);
        addCyl(out, vadd(p.c, p.u, topY), 0.22, spH, [0.5, 0.5, 0.56], 4, b);
        if (nightLit) addBox(out, vadd(p.c, p.u, topY + spH), [0.9, 0.9, 0.9], [3.2, 0.4, 0.3], b);
      } else if (rt < 0.82) {
        addBox(out, vadd(p.c, p.u, topY + 1.3), [topW * 0.32, 2.6, topD * 0.32], [0.30, 0.30, 0.34], b);  // plant housing
        // Twin HVAC / duct boxes next to plant housing on mid paddock blocks.
        if (!nightLit && h >= 10 && h < 40 && rt > 0.55) {
          const hx = (hash(k * 7.1 + side) - 0.5) * topW * 0.35;
          const hz = (hash(k * 9.3 + side) - 0.5) * topD * 0.35;
          // Bottom 5 cm under the plant housing's; the top stays at topY + 1.4.
          addBox(out,
            vadd(vadd(vadd(p.c, p.u, topY + 0.675), p.r, hx), p.t, hz),
            [topW * 0.18, 1.45, topD * 0.22], [0.38, 0.38, 0.40], b);
        }
      }
      // else: clean chamfered cap, no finial
    }
    // city.js:407-410: night signage (HDR neon crown band) + aircraft beacon.
    if (nightLit) {
      const NEON: readonly RVec3[] = [[2.6, 1.5, 0.5], [0.5, 1.9, 2.6], [2.6, 0.6, 1.7], [0.9, 2.4, 0.9], [2.2, 0.9, 2.4]];
      if (hash(k * 6.7 + side * 1.3) < 0.62) {
        const neon = NEON[Math.floor(hash(k * 8.9 + side * 2.1) * NEON.length) % NEON.length]!;
        const by = topY * (0.5 + hash(k * 2.3 + side) * 0.32);
        addBox(out, vadd(p.c, p.u, by), [topW * 1.05, 0.7, topD * 1.05], neon, b);
      }
      if (h > 38) {
        addCyl(out, vadd(p.c, p.u, topY), 0.14, 2.4, [0.30, 0.30, 0.34], 4, b);          // beacon mast
        addBox(out, vadd(p.c, p.u, topY + 2.4), [1.1, 1.1, 1.1], [3.2, 0.4, 0.3], b);    // red beacon
      }
    }
    blockAt(k, side, gap, d / 2);   // solid: stop the car before the façade
    massAdd(p.c, w, d, b);          // claim the ground so later masses yield
  };
  // city.js:426-428: neonTowerBody returns early with out._mat still METAL;
  // the wrapper resets it on every path.
  const neonTower = (...args: NeonTowerArgs): void => { neonTowerBody(...args); out._mat = 0; };
  // city.js:429-684.
  const neonTowerBody = (k: number, side: number, dist: number, w: number, h: number, d: number,
    neon: RVec3, kind: string, tone: TowerTone | null | undefined, neonAmt?: number | null): void => {
    const a = anchor(k, side, dist), b = basisOf(a);
    const reach = Math.max(w, d);   // used below for cylinder/dome/drum radii
    // city.js:432-440: footprint guard over the widest section.
    const gw = reach * 1.4;
    if (rejBox(a.c, [gw, h, gw], b)) return;
    // city.js:443-455: yield to a mass already here; claim the widest
    // section's footprint (round kinds build off `reach`).
    const fw = kind === "podium" ? 1.35 : 1, fd = kind === "podium" ? 1.35 : kind === "jenga" ? 1.22 : 1;
    const roundR = kind === "cylinder" ? 0.5 : kind === "pyramid" ? 0.62 : kind === "drum" ? 0.6 : 0;
    const footW = roundR ? 2 * roundR * reach : w * fw, footD = roundR ? 2 * roundR * reach : d * fd;
    if (massBlocked(a.c, footW, footD, b, 0.82)) { blockAt(k, side, dist - reach / 2, reach / 2); return; }
    // city.js:460-462: …and yield to a TREE already standing here.
    if (treeInFootprint(vadd(a.c, a.u, h / 2), footW, h, footD, b)) { blockAt(k, side, dist - reach / 2, reach / 2); return; }
    massAdd(a.c, footW, footD, b);
    const bodyCol: RVec3 = NIGHT ? (tone && tone.n || [0.14, 0.14, 0.17]) : (tone && tone.d || [0.40, 0.41, 0.44]);
    const cap: RVec3 = NIGHT ? [0.09, 0.09, 0.12] : [0.31, 0.32, 0.35];
    const na = neonAmt == null ? (theme === "street_night" ? 1 : 0) : neonAmt;  // 0=general … 1=neon
    const neonOn = NIGHT && na > 0.3;                                           // bright neon trim?
    const warm: RVec3 = [1.0, 0.80, 0.46];                                     // general office light
    const med = bodyCol[0] > 0.6 && bodyCol[0] > bodyCol[2] + 0.08;   // warm light wall
    const medWin: RVec3 = [bodyCol[0] * 0.34, bodyCol[1] * 0.30, bodyCol[2] * 0.26];   // dark window reveal
    const dayGridAt = (cen: RVec3, sw: number, sh: number, sd: number) => {
      const rows = lod(Math.max(4, Math.min(10, Math.round(sh / 4.4))), 3);   // perf: cap + coarser; mobile LOD via lod()
      const dface = (nAxis: 0 | 2, nSign: number, nHalf: number, wAxis: 0 | 2, faceW: number, simple: boolean) => {
        // perf: fewer panes per face (was simple 4/4.0, full 7/2.4; rowN 9/5.0)
        const cols = simple ? 2 : lod(Math.max(2, Math.min(6, Math.round(faceW / 3.1))), 2);
        const rowN = simple ? lod(Math.max(2, Math.min(6, Math.round(sh / 6.4))), 2) : rows;
        const PANE_STANDOFF = 0.05;
        const gBase = (thick: number) => vadd(cen, b[nAxis], nSign * (nHalf + PANE_STANDOFF + thick / 2));
        const dim = (thin: number, hgt: number, wid: number): RVec3 => { const a: Vec3 = [0, 0, 0]; a[nAxis] = thin; a[1] = hgt; a[wAxis] = wid; return a; };
        for (let c = 0; c < cols; c++) {
          const cx = (-0.5 + (c + 0.5) / cols) * faceW;
          for (let r = 0; r < rowN; r++) {
            const ry01 = (r + 0.5) / rowN;
            const at = (thick: number) => vadd(vadd(gBase(thick), b[wAxis], cx), b[1], (-0.5 + ry01) * sh);
            const thick = med ? 0.06 : 0.08;
            const sz = med ? dim(0.06, (sh / rowN) * 0.42, (faceW / cols) * 0.42) : dim(0.08, (sh / rowN) * 0.62, (faceW / cols) * 0.6);
            const pc = at(thick);
            if (sunk(pc, b, sz)) continue;   // inside the hillside: invisible
            if (med) { out._mat = MAT.GLASS; addBox(out, pc, sz, medWin, b); out._mat = 0; }
            else { const t01 = 0.42 + ry01 * 0.16; glassBuf._mat = MAT.GLASS; addBox(glassBuf, pc, sz, [t01 * 0.40, t01 * 0.47, t01 * 0.62], b); glassBuf._mat = 0; }
          }
        }
      };
      dface(0, -side, sw / 2, 2, sd, false);   // track-facing: full
      dface(2, 1, sd / 2, 0, sw, true);        // +t side: simple
      dface(2, -1, sd / 2, 0, sw, true);       // -t side: simple
      // Back face undressed on purpose (matches neonFacade).
    };
    const bmat = NIGHT ? MAT.CONCRETE : facadeMat(bodyCol);
    const sec = (yb: number, sw: number, sh: number, sd: number, seed: number, to?: number, ro?: number): boolean => {
      const cen = vadd(vadd(vadd(a.c, a.u, yb + sh / 2), b[2], to || 0), b[0], ro || 0);
      const prevMat = out._mat;
      out._mat = bmat;
      const okB = addBox(out, cen, [sw, sh, sd], bodyCol, b);
      out._mat = prevMat;
      if (okB === false) return false;
      if (NIGHT) neonFacade(cen, b, side, sw, sh, sd, neon, seed, na);
      else dayGridAt(cen, sw, sh, sd);
      return okB;
    };
    out._mat = MAT.METAL;
    if (kind === "tiered") {
      let yb = 0, tw = w, td = d;
      const frac = [0.46, 0.32, 0.22] as const;
      for (let i = 0; i < 3; i++) {
        const th = h * frac[i as 0 | 1 | 2];
        if (sec(yb, tw, th, td, k * 3.7 + side * 1.9 + i * 11) === false) return;
        yb += th; tw *= 0.66; td *= 0.66;
      }
      addBox(out, vadd(a.c, a.u, h + 0.5), [tw, 1.0, td], cap, b);
    } else if (kind === "podium") {
      const podH = h * 0.28;
      if (sec(0, w * 1.35, podH, d * 1.35, k * 3.1 + side) === false) return;          // wide retail podium
      if (sec(podH, w * 0.7, h - podH, d * 0.7, k * 5.1 + side * 2) === false) return;  // slender tower
      addBox(out, vadd(a.c, a.u, h + 0.5), [w * 0.45, 1.0, d * 0.45], cap, b);
    } else if (kind === "slab") {
      if (sec(0, w, h, d, k * 3.7 + side * 1.9) === false) return;   // body rejected -> drop its dependents // clean tall slab
      addBox(out, vadd(a.c, a.u, h + 0.5), [w * 0.92, 1.0, d * 0.92], cap, b);
    } else if (kind === "twin") {
      const td = d * 0.4, off = d * 0.28;
      for (let i = 0; i < 2; i++) {
        const o = i === 0 ? -off : off, th = h * (i === 0 ? 1 : 0.82);
        if (sec(0, w * 0.9, th, td, k * 3.1 + side + i * 7, o) === false) continue;
        addBox(out, vadd(vadd(a.c, a.u, th + 0.4), b[2], o), [w * 0.6, 0.8, td * 0.8], cap, b);
      }
    } else if (kind === "jenga") {                              // offset stacked boxes
      const n2 = 4, bh = h / n2;
      for (let i = 0; i < n2; i++) {
        if (sec(i * bh, w * 0.86, bh, d * 0.72, k + i * 9.1, (hash(k + i * 5.5) - 0.5) * d * 0.5) === false)
          return;
      }
      addBox(out, vadd(a.c, a.u, h + 0.5), [w * 0.5, 1.0, d * 0.5], cap, b);
    } else if (kind === "cylinder") {                           // round glass tower
      const R = reach * 0.5, segs = 14;
      addCyl(out, a.c, R, h, bodyCol, segs, b);
      const rings = Math.max(3, Math.min(14, Math.round(h / 6)));
      for (let r = 1; r < rings; r++) {
        const isLit = NIGHT && hash(k + r * 3.3 + side) < (0.26 + na * 0.18);
        const col: RVec3 = isLit ? (neonOn ? neon : warm) : [0.06, 0.06, 0.09];
        addCyl(out, vadd(a.c, a.u, r * (h / rings)), R * 1.01, (h / rings) * (isLit ? 0.22 : 0.1), col, segs, b);
      }
      addCyl(out, vadd(a.c, a.u, h), R * 0.6, 1.4, cap, segs, b);
    } else if (kind === "spire") {                              // tapered shaft + antenna
      const bh = h * 0.74, R = reach * 0.5;
      addFrustum(out, a.c, R, R * 0.42, bh, bodyCol, 8, b);
      const rings = Math.max(3, Math.round(bh / 7));
      for (let r = 1; r < rings; r++) {
        const isLit = NIGHT && hash(k + r * 2.1 + side) < (0.26 + na * 0.16);
        const col: RVec3 = isLit ? (neonOn ? neon : warm) : [0.06, 0.06, 0.09];
        addCyl(out, vadd(a.c, a.u, r * (bh / rings)), R * (1 - 0.55 * r / rings) * 1.02, (bh / rings) * (isLit ? 0.2 : 0.09), col, 8, b);
      }
      addCyl(out, vadd(a.c, a.u, bh), 0.35, h - bh, neonOn ? neon : [0.4, 0.4, 0.45], 4, b);
      if (NIGHT) addBox(out, vadd(a.c, a.u, h), [0.9, 0.9, 0.9], [3.0, 0.6, 0.4], b);  // beacon
    } else if (kind === "pyramid") {                            // Luxor-style taper
      const R = reach * 0.62;
      addFrustum(out, a.c, R, R * 0.08, h, bodyCol, 4, b);
      if (neonOn) {
        for (const e of [-1, 1]) addBox(out, vadd(vadd(a.c, a.u, h * 0.5), b[2], e * R * 0.5), [R, h * 0.96, 0.3], [neon[0] * 0.7, neon[1] * 0.7, neon[2] * 0.7], b);
      }
      // city.js:573-574: seated ON the apex.
      if (NIGHT) addBox(out, vadd(a.c, a.u, h + 0.7), [1.4, 1.4, 1.4], neonOn ? [3.0, 1.6, 0.6] : [3.0, 0.6, 0.4], b);  // apex beacon
    } else if (kind === "screen") {                             // giant neon screen building (BRIGHT)
      if (sec(0, w, h, d, k * 3.7 + side * 1.9) === false) return;   // body rejected -> drop its dependents
      const sc: RVec3 = neonOn ? [neon[0] * 1.25, neon[1] * 1.25, neon[2] * 1.25] : (NIGHT ? [warm[0] * 0.9, warm[1] * 0.9, warm[2] * 0.9] : [0.30, 0.33, 0.40]);
      addBox(out, vadd(vadd(a.c, a.u, h * 0.56), b[0], -side * (w / 2 + 0.25)), [0.3, h * 0.66, d * 0.82], sc, b);
      if (neonOn) addBox(out, vadd(vadd(a.c, a.u, h * 0.56), b[0], -side * (w / 2 + 0.28)), [0.1, h * 0.6, d * 0.74], [neon[0] * 0.4, neon[1] * 0.4, neon[2] * 0.4], b);
    } else if (kind === "clad") {                               // neon-banded tower (BRIGHT)
      if (sec(0, w, h, d, k * 3.7 + side * 1.9) === false) return;   // body rejected -> drop its dependents
      if (neonOn) { const bands = Math.max(4, Math.round(h / 5)); for (let i = 1; i < bands; i++) addBox(out, vadd(a.c, a.u, i * (h / bands)), [w * 1.04, (h / bands) * 0.22, d * 1.04], neon, b); }
      addBox(out, vadd(a.c, a.u, h + 0.5), [w * 0.6, 1.0, d * 0.6], cap, b);
    } else if (kind === "dome") {                              // body + drum + dome cap (civic landmark)
      const bh = h * 0.78, R = reach * 0.34;
      if (sec(0, w, bh, d, k * 3.7 + side * 1.9) === false) return;   // body rejected -> drop its dependents
      addCyl(out, vadd(a.c, a.u, bh), R, h * 0.10, cap, 14, b);                                            // drum
      addCone(out, vadd(a.c, a.u, bh + h * 0.10), R * 1.1, h * 0.16, neonOn ? neon : (NIGHT ? warm : cap), 14, b);  // dome
      if (NIGHT) addBox(out, vadd(a.c, a.u, h + 0.6), [0.7, 0.7, 0.7], neonOn ? [3.0, 2.0, 0.8] : [3.0, 0.6, 0.4], b);
    } else if (kind === "chevron") {                           // pitched / gabled roof block
      const bh = h * 0.82;
      if (sec(0, w, bh, d, k * 3.7 + side * 1.9) === false) return;   // body rejected -> drop its dependents // addPrism takes its `c` as the BASE
      seat.prism(out, vadd(a.c, a.u, bh), [w, h * 0.18, d], cap, b);                                       // gable roof, seated on the body
      if (neonOn) addBox(out, vadd(a.c, a.u, bh + h * 0.18), [w * 1.02, 0.5, d * 1.02], neon, b);          // eave neon
    } else if (kind === "notch") {                             // twin slabs split by a vertical slot
      // city.js:597-600: split ALONG THE STREET (b[2], extent d).
      const podH = h * 0.22, off = d * 0.30;
      if (sec(0, w, podH, d, k * 3.1 + side) === false) return;   // body rejected -> drop its dependents // shared podium base
      for (const o2 of [-off, off]) {
        if (sec(podH, w, h - podH, d * 0.42, k * 4.3 + side + o2, o2, o2 > 0 ? side * 0.07 : 0) === false)
          return;             // two towers
      }
      addBox(out, vadd(a.c, a.u, h + 0.5), [w * 0.92, 1.0, d * 0.9], cap, b);
    } else if (kind === "fin") {                               // slab with proud vertical fins on the face
      if (sec(0, w, h, d, k * 3.7 + side * 1.9) === false) return;   // body rejected -> drop its dependents
      const fins = Math.max(3, Math.round(w / 4));
      for (let i = 0; i < fins; i++) {
        const fx = (-0.5 + (i + 0.5) / fins) * w, lit = neonOn && hash(k + i * 5.1 + side) < 0.5;
        // city.js:613-617: stood on the anchor; on a slope the foot reaches
        // down to the terrain under it (0.3 m embed).
        const fc = vadd(vadd(vadd(a.c, a.u, h * 0.47), b[2], fx), b[0], -side * (d / 2 + 0.2));
        const fg = terrainYAt(fc[0], fc[2]);
        const drop = fg != null ? Math.max(0, a.c[1] - (fg - 0.3)) : 0;
        addBox(out, vadd(fc, a.u, -drop / 2), [0.5, h * 0.94 + drop, 0.5], lit ? neon : cap, b);
      }
      addBox(out, vadd(a.c, a.u, h + 0.5), [w * 0.92, 1.0, d * 0.92], cap, b);
    } else if (kind === "antenna") {                           // flat-top tower + mast cluster + beacons
      if (sec(0, w, h, d, k * 3.7 + side * 1.9) === false) return;   // body rejected -> drop its dependents
      addBox(out, vadd(a.c, a.u, h + 0.4), [w * 0.9, 0.8, d * 0.9], cap, b);
      const masts = 3;
      for (let i = 0; i < masts; i++) {
        const mx = (-0.5 + (i + 0.5) / masts) * w * 0.6, mh = h * (0.14 + hash(k + i * 7.3) * 0.16);
        addCyl(out, vadd(vadd(a.c, a.u, h), b[2], mx), 0.22, mh, [0.4, 0.4, 0.45], 4, b);
        if (NIGHT) addBox(out, vadd(vadd(a.c, a.u, h + mh), b[2], mx), [0.5, 0.5, 0.5], [3.0, 0.5, 0.35], b);  // beacon
      }
    } else if (kind === "cross") {                             // two perpendicular slabs (+ footprint)
      if (sec(0, w, h, d * 0.5, k * 3.7 + side * 1.9) === false) return;   // body rejected -> drop its dependents // arm along tangent
      // city.js:635-638: lift the crossing arm by MIN_SEP (TrackGeom via core).
      const SEP = core.geom.MIN_SEP || 0.03;
      const cen2 = vadd(a.c, a.u, h * 0.5 + SEP);
      addBox(out, cen2, [w * 0.5, h, d], bodyCol, b);                                                       // arm along width
      if (NIGHT) neonFacade(cen2, b, side, w * 0.5, h, d, neon, k * 6.1 + side, na);
      else dayGridAt(cen2, w * 0.5, h, d);
      addBox(out, vadd(a.c, a.u, h + 0.5 + SEP), [w * 0.6, 1.0, d * 0.6], cap, b);
    } else if (kind === "arch") {                              // portal / gateway — two legs + spanning lintel
      // city.js:645-646: legs split along the street (d), as notch's towers.
      const legW = d * 0.26, gp = d * 0.46, legH = h * 0.78, off = gp / 2 + legW / 2;
      for (const o3 of [-off, off]) {
        if (sec(0, w, legH, legW, k * 3.3 + side + o3 * 7, o3, o3 > 0 ? side * 0.07 : 0) === false)
          return;   // legs
      }
      if (sec(legH, w, h - legH, d, k * 5.9 + side) === false) return;                                          // lintel
      addBox(out, vadd(a.c, a.u, h + 0.5), [w * 0.96, 1.0, d * 0.9], cap, b);
    } else if (kind === "ziggurat") {                          // stepped terrace (many small steps)
      const steps = 6; let yb = 0, tw = w, td = d;
      for (let i = 0; i < steps; i++) {
        const th = h / steps;
        if (sec(yb, tw, th, td, k * 2.9 + side + i * 8) === false) return;
        yb += th; tw *= 0.82; td *= 0.82;
      }
      addBox(out, vadd(a.c, a.u, h + 0.4), [tw, 0.8, td], cap, b);
    } else if (kind === "drum") {                              // squat arena / stadium drum
      const R = reach * 0.6, dh = h * 0.5;
      addCyl(out, a.c, R, dh, bodyCol, 18, b);
      const ring: RVec3 = NIGHT ? (neonOn ? neon : warm) : [0.30, 0.34, 0.42];
      addCyl(out, vadd(a.c, a.u, dh * 0.5), R * 1.02, dh * 0.16, ring, 18, b);            // mid neon ring
      addCyl(out, vadd(a.c, a.u, dh), R * 0.96, 1.2, cap, 18, b);                         // roof rim
      addCyl(out, vadd(a.c, a.u, dh + 1.0), R * 0.7, 0.8, cap, 18, b);                    // shallow dome hint
    } else if (kind === "hall") {                              // low wide gabled hall (market / depot)
      const hh = h * 0.5;
      if (sec(0, w, hh * 0.7, d, k * 3.3 + side) === false) return;   // body rejected -> drop its dependents // low body
      seat.prism(out, vadd(a.c, a.u, hh * 0.7), [w, hh * 0.3, d], cap, b);               // gable roof, seated on the body
      if (neonOn) addBox(out, vadd(a.c, a.u, hh * 0.7), [w * 1.02, 0.4, d * 1.02], neon, b);  // eave neon
    } else { // setback
      const setH = h * 0.84;
      if (sec(0, w, setH, d, k * 3.7 + side * 1.9) === false) return;   // body rejected -> drop its dependents
      out._mat = bmat;
      addBox(out, vadd(a.c, a.u, setH + (h - setH) / 2), [w * 0.72, h - setH, d * 0.72], bodyCol, b);
      out._mat = MAT.METAL;
      addBox(out, vadd(a.c, a.u, h + 0.5), [w * 0.5, 1.0, d * 0.5], cap, b);
    }
    out._mat = 0;
    blockAt(k, side, dist - reach / 2, reach / 2);
  };

  // city.js:685-692.
  const neonSign = (k: number, side: number, dist: number, h: number, neon: RVec3): void => {
    const a = anchor(k, side, dist), b = basisOf(a);
    if (onTrack(a.c[0], a.c[2], 2)) return;
    addBox(out, vadd(a.c, a.u, h * 0.5), [0.6, h, 0.6], [0.10, 0.10, 0.12], b);          // mast
    const col: RVec3 = NIGHT ? neon : [neon[0] * 0.4 + 0.3, neon[1] * 0.4 + 0.3, neon[2] * 0.4 + 0.3];
    addBox(out, vadd(a.c, a.u, h * 0.62), [0.9, h * 0.6, 0.35], col, b);                  // vertical blade
    blockAt(k, side, dist - 0.6, 0.6);
  };

  // city.js:693-718.
  const streetLamp = (k: number, side: number, dist: number, head: RVec3, h: number, lstyle?: string | null): void => {
    const a = anchor(k, side, dist);
    if (onTrack(a.c[0], a.c[2], 2)) return;
    const pole: RVec3 = [0.13, 0.13, 0.15];
    const lit: Vec3 = NIGHT ? [head[0] * 1.4, head[1] * 1.4, head[2] * 1.4]
                            : [head[0] * 0.72, head[1] * 0.72, head[2] * 0.70];
    ctx.instance(
      `lamp|${lstyle || "arm"}|${h}|${side}|${lit.join(",")}`,
      { o: a.c, r: a.r, u: a.u, t: a.t },
      (rec) => {
        rec.cyl([0, -0.4, 0], 0.18, h + 0.4, pole, 6);                              // column, sunk base
        if (lstyle === "globe") {                                                   // heritage twin-globe
          for (const e of [-1, 1]) {
            rec.box([0, h, e * 0.55], [0.16, 0.16, 1.1], pole);                     // bracket
            rec.box([0, h - 0.1, e * 1.1], [0.7, 0.8, 0.7], lit);                   // glowing globe
          }
        } else if (lstyle === "post") {                                             // simple modern cap
          rec.box([0, h, 0], [0.5, 0.5, 0.5], lit);
        } else {                                                                    // cantilever arm
          // arm + head as one cantilever: the member is never optional
          rec.box([-side * 1.7 / 2, h - 0.2, 0], [1.7 + 0.5, 0.18, 0.22], pole);    // arm
          rec.box([-side * 1.7, h - 0.2, 0], [0.85, 0.35, 0.55], lit);              // head
        }
      },
      { kind: "streetLamp", k, side });
  };

  // city.js:719-755.
  const cityFront = (s0: number, s1: number, side: number, gap: number, opts?: CityFrontOpts | null): void => {
    opts = opts || {};
    const minH = opts.minH != null ? opts.minH : 16;
    const maxH = opts.maxH != null ? opts.maxH : 46;
    const depth = opts.depth != null ? opts.depth : 22;
    const lit = opts.lit === false ? false : NIGHT;
    const palette: readonly RVec3[] = (opts.palette && opts.palette.length) ? opts.palette
      : (lit ? [[0.17, 0.19, 0.27], [0.20, 0.21, 0.28], [0.15, 0.17, 0.24], [0.22, 0.20, 0.26]]
             : [[0.60, 0.62, 0.66], [0.66, 0.64, 0.60], [0.56, 0.58, 0.62], [0.70, 0.68, 0.64]]);
    const step = opts.step || 22;
    const o = opts;
    let idx = 0;
    along(s0, s1, step, (k) => {
      const s = hash(k * 5.3 + side * 0.9);
      const w = 14 + s * 16;                    // 14–30 m wide facade unit
      const hLocal = hash(k * 9.1 + side * 1.7);
      const hCluster = hash(Math.floor(k / 3) * 2.7 + side * 1.3);
      let h = minH + (0.6 * hLocal + 0.4 * hCluster) * (maxH - minH);
      if (hash(k * 1.7 + side * 3.1) < 0.10) h = Math.min(maxH * 1.5, h * 1.5);  // landmark tower
      const col = palette[((idx % palette.length) + palette.length) % palette.length];
      const wcol = lit ? WINTINTS[Math.floor(hash(k * 2.1 + side) * WINTINTS.length) % WINTINTS.length] : undefined;
      building(k, side, gap, w, h, depth + (s - 0.5) * depth * 0.3, {
        _kit: true,   // kit-internal: skip building()'s swapped-dimensions heuristic
        wall: col, floor: o.floor || (4 + s * 3),
        lit: lit, windowCol: o.windowCol || wcol,
        // city.js:743-751: NO `setback:` key here (building() never reads it).
      });
      idx++;
    });
  };

  // city.js:756-788.
  const house = (k: number, side: number, gap: number, w: number, h: number, d: number, opts?: HouseOpts | null): void => {
    opts = opts || {};
    const dist = gap + w / 2;
    const p = anchor(k, side, dist), b = basisOf(p);
    const ifx = p.c[0] - p.r[0] * side * w / 2, ifz = p.c[2] - p.r[2] * side * w / 2;
    if (onTrack(ifx, ifz, 2)) {
      ctx.noteSuppressed("house", `house SUPPRESSED at k=${k} side=${side}: gap=${gap} w=${w}`);
      return;
    }
    ctx.note("house", [p.c[0], p.c[1] + h / 2, p.c[2]], [w, h, d], { k, side });
    const hh = hash(k * 6.7 + side * 3.9 + gap);
    const wall = opts.wall || HOUSE_WALLS[Math.floor(hh * HOUSE_WALLS.length) % HOUSE_WALLS.length]!;
    const roofCol = opts.roof || HOUSE_ROOFS[Math.floor(hash(k * 9.1 + side) * HOUSE_ROOFS.length) % HOUSE_ROOFS.length]!;
    const roofType = opts.roofType || (hh > 0.5 ? "hip" : "gable");
    const nightLit = NIGHT && opts.lit !== false;
    // Main box mass.
    addBox(out, vadd(p.c, p.u, h / 2), [w, h, d], wall, b);
    const roofH = h * (0.42 + hash(k * 13.3 + side) * 0.20);
    const roofSz: RVec3 = [w * 1.10, roofH, d * 1.10];
    if (roofType === "hip") addPyramid(out, vadd(p.c, p.u, h), roofSz, roofCol, b);
    else addPrism(out, vadd(p.c, p.u, h), roofSz, roofCol, b);
    // Chimney on most houses (skip on some for variety).
    if (hash(k * 17 + side) > 0.3) {
      const cc = vadd(vadd(vadd(p.c, p.r, w * 0.22 * side), p.t, d * 0.12), p.u, h * 0.65);
      addCyl(out, cc, 0.32, roofH * 0.95, [0.40, 0.36, 0.34], 4, b);
    }
    const faceOff = -side * (w / 2 + 0.02);
    const winCol: RVec3 = opts.window || (nightLit ? [1.55, 1.10, 0.55] : [0.72, 0.80, 0.84]);
    addBox(out, vadd(vadd(p.c, p.r, faceOff), p.u, 1.0), [0.06, 2.0, 1.1], [0.26, 0.18, 0.13], b);
    for (const wx of [-d * 0.26, d * 0.26]) {
      addBox(out, vadd(vadd(vadd(p.c, p.r, faceOff), p.t, wx), p.u, h * 0.58), [0.06, 1.1, 1.0], winCol, b);
    }
  };

  // city.js:789-823.
  const motorhome = (k: number, side: number, gap: number, w: number, h: number, d: number, opts?: MotorhomeOpts | null): void => {
    opts = opts || {};
    const dist = gap + w / 2;
    const p = anchor(k, side, dist), b = basisOf(p);
    const ifx = p.c[0] - p.r[0] * side * w / 2, ifz = p.c[2] - p.r[2] * side * w / 2;
    if (onTrack(ifx, ifz, 2)) {
      ctx.noteSuppressed("motorhome", `motorhome SUPPRESSED at k=${k} side=${side}: gap=${gap} w=${w}`);
      return;
    }
    ctx.note("motorhome", [p.c[0], p.c[1] + h / 2, p.c[2]], [w, h, d], { k, side });
    const hh = hash(k * 7.3 + side * 4.1 + gap);
    const body = opts.wall || MOTORHOME_BODY[Math.floor(hh * MOTORHOME_BODY.length) % MOTORHOME_BODY.length]!;
    const accent: RVec3 = opts.accent || [0.75, 0.10, 0.10];
    const nightLit = NIGHT && opts.lit !== false;
    const winCol: RVec3 = opts.window || (nightLit ? [1.5, 1.3, 0.85] : [0.30, 0.36, 0.42]);
    const loH = h * 0.56;
    const start = out.pos.length;
    if (addBox(out, vadd(p.c, p.u, loH / 2), [w, loH, d], body, b) === false) return;
    addBox(out, vadd(p.c, p.u, loH + (h - loH) / 2), [w * 0.86, h - loH, d * 0.90], body, b);
    // Window ribbon along the lower deck's road-facing wall.
    const faceOff = -side * (w / 2 + 0.02);
    addBox(out, vadd(vadd(p.c, p.r, faceOff), p.u, loH * 0.62), [0.05, loH * 0.30, d * 0.82], winCol, b);
    // Livery accent stripe along the base.
    addBox(out, vadd(vadd(p.c, p.r, faceOff * 1.001), p.u, loH * 0.12), [0.06, loH * 0.14, d * 0.94], accent, b);
    const awnDist = w * 0.42;
    const awnC = vadd(vadd(p.c, p.r, faceOff - side * awnDist), p.u, loH * 0.92);
    const awning = addBox(out, awnC, [0.05, 0.10, d * 0.9], opts.awning || [0.20, 0.22, 0.26], b);
    if (awning !== false) for (const e of [-1, 1]) {
      const postC = vadd(vadd(vadd(p.c, p.r, faceOff - side * awnDist), p.t, e * d * 0.42), p.u, -0.2);
      addCyl(out, postC, 0.05, loH * 0.92 + 0.25, [0.35, 0.35, 0.38], 4, b);
    }
    // Roof AC / satellite unit.
    if (hh > 0.25) addBox(out, vadd(p.c, p.u, h + 0.3), [w * 0.28, 0.5, d * 0.20], [0.55, 0.56, 0.58], b);
    ctx.reserveEmittedSolid(out, start, b);
  };

  // city.js:824-845: tapered tower (control tower, spire) + optional antenna mast.
  const tower = (k: number, side: number, dist: number, baseW: number, h: number, opts?: CityTowerOpts | null): void => {
    opts = opts || {};
    const p = anchor(k, side, dist), b = basisOf(p);
    const ifx = p.c[0] - p.r[0] * side * baseW / 2;
    const ifz = p.c[2] - p.r[2] * side * baseW / 2;
    if (onTrack(ifx, ifz, 0)) {
      ctx.noteSuppressed("tower", `tower SUPPRESSED at k=${k} side=${side}: dist=${dist} baseW=${baseW}`);
      return;
    }
    ctx.note("tower", [p.c[0], p.c[1] + h / 2, p.c[2]], [baseW, h, baseW], { k, side });
    addFrustum(out, vadd(p.c, p.u, -0.6), baseW * 0.5, baseW * 0.335, h + 0.6, opts.col || [0.70, 0.72, 0.75], opts.seg || 8, b);   // base sunk 0.6
    const glass: RVec3 = opts.glassCol || [0.40, 0.52, 0.64];
    const rAt = (f: number) => baseW * (0.5 - 0.165 * f) * 1.03;
    addCyl(out, vadd(p.c, p.u, h * 0.40), rAt(0.40), h * 0.05, glass, opts.seg || 8, b);
    addCyl(out, vadd(p.c, p.u, h * 0.66), rAt(0.66), h * 0.05, glass, opts.seg || 8, b);
    addBox(out, vadd(p.c, p.u, h * 0.84), [baseW * 0.62, baseW * 0.05, baseW * 0.62], opts.deckCol || [0.26, 0.28, 0.32], b);   // observation deck
    if (opts.cap) addBox(out, vadd(p.c, p.u, h), [baseW * 0.7, baseW * 0.18, baseW * 0.7], opts.capCol || [0.2, 0.2, 0.24], b);
    const mastH = opts.mast === true ? Math.max(4, h * 0.12) : opts.mast;
    if (mastH) addCyl(out, vadd(p.c, p.u, h + (opts.cap ? baseW * 0.09 : 0)), 0.18, mastH, [0.3, 0.3, 0.32], 4, b);
    blockAt(k, side, dist - baseW * 0.5, baseW * 0.5);   // solid base
  };

  // city.js:846-922.
  const billboard = (k: number, side: number, gap: number, w: number, h: number, col?: RVec3 | null, opts?: BillboardOpts | null): void => {
    const st = (opts && opts.style) || kitOf("board", "panel");
    const p = anchor(k, side, gap);
    // city.js:849-852: guard the two panel ends (the face runs ALONG the tangent).
    const e0 = vadd(p.c, p.t, w / 2), e1 = vadd(p.c, p.t, -w / 2);
    if (onTrack(e0[0], e0[2], 1.0) || onTrack(e1[0], e1[2], 1.0)) {
      ctx.noteSuppressed("billboard", `billboard SUPPRESSED at k=${k} side=${side}: gap=${gap} w=${w} (a panel end is on the road)`);
      return;
    }
    ctx.note("billboard", vadd(p.c, p.u, h + 1.6), [0.3, 3.2, w], { k, side });
    const place = { o: p.c, r: p.r, u: p.u, t: p.t };
    const postCol: RVec3 = (opts && opts.postCol) || [0.2, 0.2, 0.22];
    const posts = st === "fascia" ? []
      : st === "monopole" || st === "tower" ? [0]
      : [-w * 0.4, w * 0.4];
    for (const o of posts)
      ctx.instance(`billboard-post|${h}|${st}|${postCol.join(",")}`,
        { o: vadd(p.c, p.t, o), r: p.r, u: p.u, t: p.t },
        (rec) => {
          if (st === "monopole" || st === "tower") {
            rec.cyl([0, -0.4, 0], 0.42, h + 0.4, postCol, 8);                 // one fat column
            rec.box([0, h + 0.1, 0], [0.9, 0.5, 1.6], postCol);               // panel bracket
          } else if (st === "banner") {
            rec.cyl([0, -0.4, 0], 0.09, h + 3.6, postCol, 5);                 // slim mast
          } else if (st === "led") {
            rec.cyl([0, -0.4, 0], 0.16, h + 0.4, postCol, 5);
            rec.box([0, h + 3.4, 0], [0.5, 0.3, 0.5], postCol);               // service walkway
          } else {
            rec.cyl([0, -0.4, 0], 0.12, h + 0.4, postCol, 4);                 // posts, base sunk
          }
        },
        { kind: "billboard", k, side });
    let face: RVec3 = col || [0.9, 0.85, 0.2];
    if (NIGHT) face = [Math.min(1.45, face[0] * 1.30 + 0.10),
                       Math.min(1.45, face[1] * 1.30 + 0.10),
                       Math.min(1.45, face[2] * 1.30 + 0.10)];
    // city.js:885-889: side AND postCol belong in the key.
    ctx.instance(`billboard-face|${h}|${st}|${side}|${postCol.join(",")}`,
      Object.assign({ s: [1, 1, w] as RVec3, col: face }, place),
      (rec) => {
        const NC = NODE_COLOR;
        if (st === "trivision") {
          for (let i = 0; i < 3; i++)
            rec.box([(i - 1) * 0.16, h + 0.6 + i * 1.05, 0], [0.42, 0.95, 1], NC);
        } else if (st === "arched") {
          rec.box([0, h + 1.6, 0], [0.3, 3.2, 1], NC);
          rec.prism([0, h + 3.5, 0], [0.3, 0.9, 1], NC);
        } else if (st === "led") {
          rec.box([0, h + 2.0, 0], [0.22, 3.9, 1], NC);                       // thin screen
          rec.box([0, h + 0.0, 0], [0.42, 0.30, 1], postCol);                 // bezel
          rec.box([0, h + 4.0, 0], [0.42, 0.26, 1], postCol);
        } else if (st === "fascia") {
          rec.box([0, 1.35, 0], [0.24, 1.5, 1], NC);                          // low, on the barrier
        } else if (st === "banner") {
          rec.mat(MAT.FABRIC);
          rec.box([0, h + 2.2, 0], [0.10, 4.4, 1], NC);
          rec.mat(0);
        } else if (st === "monopole" || st === "tower") {
          rec.box([0, h + 2.1, 0], [0.32, 4.2, 1], NC);
          rec.box([0, h - 0.2, 0], [0.5, 0.34, 1], postCol);                  // return wing
        } else {                                                             // panel (default): framed hoarding
          rec.box([0, h + 1.6, 0], [0.30, 3.2, 1], NC);                       // advert face
          rec.box([0, h + 3.3, 0], [0.36, 0.22, 1], postCol);                 // top frame rail
          rec.box([0, h - 0.1, 0], [0.36, 0.22, 1], postCol);                 // bottom frame rail
          rec.box([side * 0.5, h + 1.6, 0], [0.6, 0.4, 0.5], postCol);        // rear support strut
        }
      },
      { kind: "billboard", k, side });
    blockAt(k, side, gap, w * 0.4);   // posts + panel face → stop before it
  };

  return { neonFacade, building, neonTower, neonSign, streetLamp,
           cityFront, house, motorhome, tower, billboard };
}
