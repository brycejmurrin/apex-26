/**
 * SceneryIdentity: the shared circuit-identity toolkit of the buildProps
 * composite models: underpass portals, flood masts (+ ring), LED facade
 * bands, concrete canyons, sail and gridshell canopies, run-off aprons,
 * banked kerb strips, bowl seat walls, pastel street rows and the broadcast
 * compound.
 *
 * Port of f1-game js/track/scenery/identity.js:1-449 (`SceneryIdentity`).
 * Verbatim: float math keeps f1-game's operation order (including its
 * `Math.hypot` calls). This kit reads no engine global, so `create` takes no
 * `SceneryCore`. The `Log.info` trace (identity.js:10) is dropped.
 */
import type { Basis, OverheadSpanSpec, RVec3, SceneryAnchor, SceneryApi, SceneryBuffer } from "../../contracts/scenery";
import type { Vec3 } from "../../contracts/track";
import type { BuildTrack, MeshCore } from "./core";
import type { RawEmitters, StructuresApi } from "./structures";

/** A mast lamp record. build-props.js:1936 `registerMastLamp` (validated, then `lampRec`). */
export interface MastLampSpec {
  readonly pos: RVec3;
  readonly k: number;
  readonly side: number;
  readonly kind: string;
  readonly radius: number;
}

/** The buildProps ctx members identity.js:6-9 destructures and reads (build-props.js:1338-1361, :1948). */
export interface IdentityCtx {
  readonly out: SceneryBuffer;
  readonly track: BuildTrack;
  readonly n: number;
  readonly hw: Float32Array;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly NIGHT: boolean;
  readonly addBox: SceneryApi["addBox"];
  readonly addCyl: SceneryApi["addCyl"];
  /** identity.js:152 passes `basis` null when `opts.basis` is unset (build-props.js:526 accepts it). */
  addFrustum(o: SceneryBuffer, c: RVec3, rBase: number, rTop: number, h: number, col: RVec3, seg?: number, basis?: Basis | null): boolean;
  readonly RAW: RawEmitters;
  /** guards.js:129. */
  rejBox(c: RVec3, sz: RVec3, basis?: Basis | null): boolean;
  /** guards.js:135. */
  rejRad(c: RVec3, rad: number, h: number, basis?: Basis | null, crown?: boolean): boolean;
  /** build-props.js:595. */
  blockAt(k: number, side: number, innerGap: number, halfM?: number): void;
  readonly recordBarrier: SceneryApi["recordBarrier"];
  readonly onTrack: SceneryApi["onTrack"];
  readonly overheadSpan: (spec: OverheadSpanSpec) => boolean;
  readonly every: SceneryApi["every"];
  readonly hash: SceneryApi["hash"];
  readonly upOf: MeshCore["upOf"];
  readonly vadd: SceneryApi["vadd"];
  /** nature.js:92 (SceneryNature). */
  readonly anchor: (k: number, side: number, dist: number) => SceneryAnchor;
  /** structures.js:82 (SceneryStructures, created before this kit). */
  readonly along: StructuresApi["along"];
  /** city.js:161 (SceneryCity, created before this kit). */
  readonly building: SceneryApi["building"];
  readonly indexSolid: SceneryApi["indexSolid"];
  /** build-props.js:299. */
  noteSuppressed(kind: string, msg: string): void;
  /** build-props.js:1948: assigned AFTER the kits are created, so read at call time. */
  readonly registerMastLamp?: (spec: MastLampSpec) => boolean;
  /** build-props.js:268; read through ctx at call time (identity.js:370). */
  readonly terrainYAt?: SceneryApi["terrainYAt"];
  /** build-props.js:1049: reserve the footprint of geometry emitted since `start`. */
  reserveEmittedSolid(buf: SceneryBuffer, start: number, basis: Basis): boolean;
}

export type UnderpassPortalOpts = {
  readonly h?: number; readonly thick?: number; readonly col?: RVec3;
  readonly pierGap?: number; readonly pierW?: number; readonly depth?: number;
};
export type FloodMastOpts = {
  readonly h?: number; readonly cool?: boolean; readonly pool?: boolean;
  readonly arms?: number; readonly light?: boolean;
};
export type FloodMastRingOpts = FloodMastOpts & { readonly dist?: number };
export type LedFacadeBandsOpts = {
  readonly r?: number; readonly bands?: number; readonly cols?: readonly RVec3[];
  readonly seg?: number; readonly basis?: Basis | null;
};
export type ConcreteCanyonOpts = {
  readonly h?: number; readonly thick?: number; readonly col?: RVec3;
  readonly stripeCol?: RVec3 | null; readonly stripeH?: number; readonly stripeEvery?: number;
};
export type SailCanopyOpts = {
  readonly rad?: number; readonly h?: number; readonly col?: RVec3; readonly ribs?: number;
  readonly thick?: number; readonly rx?: number; readonly rz?: number;
};
export type GridshellCanopyOpts = {
  readonly w?: number; readonly depth?: number; readonly h?: number; readonly cols?: number;
  readonly rows?: number; readonly ledCols?: readonly RVec3[]; readonly strutCol?: RVec3;
};
export type BankedKerbStripOpts = {
  readonly kerbRed?: RVec3; readonly kerbWht?: RVec3; readonly saferCol?: RVec3;
  readonly saferGap?: number; readonly safer?: boolean; readonly step?: number; readonly saferStep?: number;
};
export type BowlSeatWallOpts = {
  readonly h?: number; readonly thick?: number; readonly shell?: RVec3;
  readonly crowdCols?: readonly RVec3[]; readonly step?: number;
};
export type BroadcastCompoundOpts = {
  readonly vans?: number; readonly dishes?: number; readonly spacing?: number;
  readonly vanCol?: RVec3; readonly dishCol?: RVec3; readonly mastH?: number;
};
export type PastelStreetRowOpts = {
  readonly palette?: readonly RVec3[]; readonly minH?: number; readonly maxH?: number;
  readonly depth?: number; readonly step?: number; readonly window?: RVec3;
  readonly floor?: number; readonly lit?: boolean; readonly windowCol?: RVec3;
};

/** identity.js:442-444: what `create` returns (merged into ctx and the api). */
export interface IdentityApi {
  underpassPortal(s: number, opts?: UnderpassPortalOpts | null): void;
  floodMast(k: number, side: number, dist: number, opts?: FloodMastOpts | null): void;
  floodMastRing(stepM: number, opts?: FloodMastRingOpts | null): void;
  ledFacadeBands(c: RVec3, h: number, opts?: LedFacadeBandsOpts | null): void;
  concreteCanyon(s0: number, s1: number, side: number, gap: number, opts?: ConcreteCanyonOpts | null): void;
  sailCanopy(c: RVec3, basis: Basis | null | undefined, opts?: SailCanopyOpts | null): void;
  gridshellCanopy(c: RVec3, basis: Basis | null | undefined, opts?: GridshellCanopyOpts | null): void;
  runoffApron(k: number, side: number, gap: number, sz: RVec3 | number | null | undefined, col?: RVec3 | null): void;
  bankedKerbStrip(s0: number, s1: number, side: number, opts?: BankedKerbStripOpts | null): void;
  bowlSeatWall(s0: number, s1: number, side: number, gap: number, opts?: BowlSeatWallOpts | null): void;
  pastelStreetRow(s0: number, s1: number, side: number, gap: number, opts?: PastelStreetRowOpts | null): void;
  broadcastCompound(k: number, side: number, gap: number, opts?: BroadcastCompoundOpts | null): void;
}

/** `Array.isArray` as a guard on the apron size (identity.js:257). */
const isVec = (v: unknown): v is RVec3 => Array.isArray(v);

export function create(ctx: IdentityCtx): IdentityApi {
  const { out, track, n, hw, px, py, pz, NIGHT,
          addBox, addCyl, addFrustum, RAW, rejBox, rejRad, blockAt,
          recordBarrier, onTrack, overheadSpan, every, hash, upOf, vadd,
          anchor, along, building, indexSolid } = ctx;

  // Cross-track composite helpers (identity.js:12-15): footprints that must
  // stay OFF the racing line use rejBox; overhead decks cars pass under emit
  // via RAW.addBox so the guarded wrappers do not cull them.

  // A lattice member that MAY legitimately overhang the track draws via RAW
  // there; clear of the tarmac it goes through the guarded path. identity.js:17-22.
  const overheadBox = (c: RVec3, sz: RVec3, col: RVec3, b: Basis) =>
    rejBox(c, sz, b) ? RAW.addBox(out, c, sz, col, b) : addBox(out, c, sz, col, b);

  // identity.js:24-60.
  const underpassPortal = (s: number, opts?: UnderpassPortalOpts | null): void => {
    opts = opts || {};
    const k = ((Math.round(s * n) % n) + n) % n;
    const clearH = opts.h != null ? opts.h : 5.5;
    const thick = opts.thick != null ? opts.thick : 1.4;
    const col: RVec3 = opts.col || [0.10, 0.10, 0.12];
    const pierGap = opts.pierGap != null ? opts.pierGap : 1.4;
    const pierW = opts.pierW != null ? opts.pierW : 1.6;
    const depth = opts.depth != null ? opts.depth : 14;
    const r: RVec3 = [track.rx[k]!, track.ry[k]!, track.rz[k]!];
    const t: RVec3 = [track.tx[k]!, track.ty[k]!, track.tz[k]!];
    const u = upOf(track, k);
    const b: Basis = [r, u, t];
    // Piers sit beyond the road edge — full-footprint guard (not single-point).
    for (const side of [-1, 1]) {
      const a = anchor(k, side, pierGap + pierW / 2);
      const pierSz: RVec3 = [pierW, clearH + thick * 0.5, depth * 0.55];
      if (rejBox(a.c, pierSz, [a.r, a.u, a.t])) {
        ctx.noteSuppressed("underpassPortal", `underpassPortal pier SUPPRESSED at s=${s} side=${side}`);
        continue;
      }
      addBox(out, vadd(a.c, a.u, pierSz[1] / 2), pierSz, col, [a.r, a.u, a.t]);
      blockAt(k, side, pierGap, depth * 0.25);
    }
    // Overhead slab intentionally spans tarmac (cars pass under) → RAW.
    const span = hw[k]! * 2 + (pierGap + pierW) * 2 + 1.5;
    overheadSpan({
      id: `underpass-${k}`, frac: s, clearance: clearH,
      thickness: thick, depth, span, color: col,
    });
    // Underside soffit just BELOW the deck (identity.js:54-56).
    const soff: RVec3 = [Math.min(1, col[0] * 1.35 + 0.04), Math.min(1, col[1] * 1.35 + 0.04), Math.min(1, col[2] * 1.4 + 0.05)];
    RAW.addBox(out, [px[k]! + u[0] * (clearH - 0.09), py[k]! + u[1] * (clearH - 0.09), pz[k]! + u[2] * (clearH - 0.09)],
               [span * 0.96, 0.18, depth * 0.92], soff, b);
  };

  // identity.js:62-122.
  const floodMast = (k: number, side: number, dist: number, opts?: FloodMastOpts | null): void => {
    opts = opts || {};
    const h = opts.h != null ? opts.h : 36;
    const cool = opts.cool !== false;
    const pool = opts.pool !== false;
    const arms = opts.arms != null ? opts.arms : 2;
    const light = opts.light !== false;
    const poleCol: RVec3 = [0.14, 0.14, 0.17];
    const lens: RVec3 = cool
      ? (NIGHT ? [1.22, 1.28, 1.40] : [0.96, 1.00, 1.06])
      : (NIGHT ? [1.30, 1.18, 0.88] : [1.02, 0.96, 0.82]);
    const a = anchor(k, side, dist), b: Basis = [a.r, a.u, a.t];
    const foot: RVec3 = [2.8, h, 2.8];
    if (rejBox(a.c, foot, b)) {
      ctx.noteSuppressed("floodMast", `floodMast SUPPRESSED at k=${k} side=${side}: dist=${dist}`);
      return;
    }
    addCyl(out, a.c, 0.45, h, poleCol, 6, b);
    const top = vadd(a.c, a.u, h);
    // Dual (or multi) arms reaching toward the track (−side along r).
    let lensPos: Vec3 | null = null;
    for (let i = 0; i < arms; i++) {
      const armOff = (i - (arms - 1) / 2) * 1.8;
      const arm = vadd(vadd(top, a.t, armOff), a.r, -side * 1.6);
      addBox(out, arm, [3.4, 0.35, 0.55], poleCol, b);
      const head = vadd(arm, a.r, -side * 1.3);
      addBox(out, head, [1.6, 0.55, 1.1], lens, b);
      // One emitter per mast at the bank centre (middle arm, or sole arm).
      if (i === (arms >> 1)) lensPos = head;
    }
    // Crossbar / bank housing
    addBox(out, top, [1.2, 0.9, arms * 1.9 + 0.6], [0.22, 0.22, 0.26], b);
    if (pool) {
      const poolCol: RVec3 = cool ? [0.72, 0.78, 0.88] : [0.82, 0.78, 0.62];
      addBox(out, vadd(a.c, a.u, 0.10), [7.5, 0.18, 7.5], poolCol, b);
    }
    blockAt(k, side, dist - 0.6, 2);
    const register = ctx.registerMastLamp;
    if (light && typeof register === "function" && lensPos) {
      // Carry the bank's real throw so the light pool can land (identity.js:101-112).
      const lp: Vec3 = lensPos;
      const kk = ((Math.round(k) % n) + n) % n;
      const throwR = Math.hypot(lp[0] - px[kk]!, lp[1] - py[kk]!, lp[2] - pz[kk]!);
      register({
        pos: [lp[0], lp[1], lp[2]],
        k, side,
        kind: cool ? "flood_bank" : "halogen",
        radius: Math.min(110, throwR * 1.5),
      });
    }
  };

  // identity.js:124-131.
  const floodMastRing = (stepM: number, opts?: FloodMastRingOpts | null): void => {
    const o: FloodMastRingOpts = opts || {};
    const dist = o.dist != null ? o.dist : 14;
    every(stepM || 55, (k) => {
      floodMast(k, -1, dist, o);
      floodMast(k, 1, dist, o);
    });
  };

  // identity.js:133-154.
  const ledFacadeBands = (c: RVec3, h: number, opts?: LedFacadeBandsOpts | null): void => {
    opts = opts || {};
    const r0 = opts.r != null ? opts.r : 8;
    const bands = opts.bands != null ? opts.bands : 10;
    const cols: readonly RVec3[] = opts.cols || [[1.4, 0.35, 0.08], [1.5, 0.55, 0.12], [1.2, 0.18, 0.05], [1.6, 0.85, 0.20]];
    const seg = opts.seg != null ? opts.seg : 8;
    const basis = opts.basis || null;
    const bh = h / bands;
    // Guard widest frustum footprint once — if base covers track, skip all bands.
    if (rejRad(c, r0, h, basis)) {
      ctx.noteSuppressed("ledFacadeBands", `ledFacadeBands SUPPRESSED at [${c[0]|0},${c[2]|0}]`);
      return;
    }
    for (let i = 0; i < bands; i++) {
      const t = i / Math.max(1, bands - 1);
      const rB = r0 * (1 - t * 0.55);
      const rT = r0 * (1 - (t + 1 / bands) * 0.55);
      const col = cols[i % cols.length]!;
      const mid: RVec3 = [c[0], c[1] + (i + 0.5) * bh, c[2]];
      addFrustum(out, mid, rB, Math.max(0.4, rT), bh * 0.92, col, seg, basis);
    }
  };

  // identity.js:156-182.
  const concreteCanyon = (s0: number, s1: number, side: number, gap: number, opts?: ConcreteCanyonOpts | null): void => {
    opts = opts || {};
    const h = opts.h != null ? opts.h : 2.4;
    const thick = opts.thick != null ? opts.thick : 0.55;
    const col: RVec3 = opts.col || [0.72, 0.73, 0.76];
    const stripeCol = opts.stripeCol || null;
    const stripeH = opts.stripeH != null ? opts.stripeH : 0.35;
    const stripeEvery = opts.stripeEvery != null ? opts.stripeEvery : 2;
    recordBarrier(s0, s1, side, gap);
    let stripeI = 0;
    along(s0, s1, 5.5, (k, spacing) => {
      const p = anchor(k, side, gap);
      const sz: RVec3 = [thick, h, spacing];
      if (rejBox(p.c, sz, [p.r, p.u, p.t])) {
        ctx.noteSuppressed("concreteCanyon", `concreteCanyon SUPPRESSED at k=${k} side=${side}: gap=${gap}`);
        return;
      }
      addBox(out, vadd(p.c, p.u, h / 2), sz, col, [p.r, p.u, p.t]);
      if (stripeCol && (stripeI++ % stripeEvery === 0)) {
        addBox(out, vadd(p.c, p.u, h * 0.55), [thick + 0.08, stripeH, spacing * 0.55], stripeCol, [p.r, p.u, p.t]);
      }
      // The seam tag deliberately leaves stripeCol out (identity.js:177-180).
    }, `canyon|${side}|${gap}|${thick}|${h}|${col.join(",")}`);
  };

  // identity.js:184-213.
  const sailCanopy = (c: RVec3, basis: Basis | null | undefined, opts?: SailCanopyOpts | null): void => {
    opts = opts || {};
    const rad = opts.rad != null ? opts.rad : 18;
    const lift = opts.h != null ? opts.h : 14;
    const col: RVec3 = opts.col || [0.92, 0.90, 0.84];
    const ribs = opts.ribs != null ? opts.ribs : 8;
    const thick = opts.thick != null ? opts.thick : 0.55;
    const b: Basis = basis || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const u = b[1], r = b[0], f = b[2];
    // Mast / hub under sail — guard footprint so the support never sits on tarmac.
    const hub: RVec3 = [c[0], c[1], c[2]];
    if (rejBox(hub, [3.5, lift, 3.5], b)) {
      ctx.noteSuppressed("sailCanopy", `sailCanopy SUPPRESSED at [${c[0]|0},${c[2]|0}]`);
      return;
    }
    addCyl(out, hub, 0.55, lift, [0.28, 0.28, 0.32], 6, b);
    const crown = vadd(hub, u, lift);
    // Sail disc as a flat wide box (ellipse approximated by axis sizes).
    const rx = opts.rx != null ? opts.rx : rad;
    const rz = opts.rz != null ? opts.rz : rad * 0.72;
    const sailC = vadd(crown, u, thick / 2);
    overheadBox(sailC, [rx * 2, thick, rz * 2], col, b);
    for (let i = 0; i < ribs; i++) {
      const a = (i / ribs) * Math.PI * 2;
      const ox = Math.cos(a) * rx * 0.85, oz = Math.sin(a) * rz * 0.85;
      const tip = vadd(vadd(crown, r, ox), f, oz);
      const mid: RVec3 = [(crown[0] + tip[0]) / 2, (crown[1] + tip[1]) / 2 - 0.4, (crown[2] + tip[2]) / 2];
      addBox(out, mid, [0.22, 0.22, Math.hypot(ox, oz) || 1], [0.35, 0.35, 0.40], b);
    }
  };

  // identity.js:215-253.
  const gridshellCanopy = (c: RVec3, basis: Basis | null | undefined, opts?: GridshellCanopyOpts | null): void => {
    opts = opts || {};
    const w = opts.w != null ? opts.w : 40;
    const depth = opts.depth != null ? opts.depth : 28;
    const peakH = opts.h != null ? opts.h : 22;
    const cols = opts.cols != null ? opts.cols : 7;
    const rows = opts.rows != null ? opts.rows : 5;
    const ledCols: readonly RVec3[] = opts.ledCols || [[0.2, 1.1, 1.2], [1.2, 0.25, 0.7], [1.1, 0.85, 0.25]];
    const strutCol: RVec3 = opts.strutCol || [0.08, 0.09, 0.12];
    const b: Basis = basis || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const r = b[0], u = b[1], f = b[2];
    // Support feet at the four corners — full-box guard.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const foot = vadd(vadd(c, r, sx * w * 0.42), f, sz * depth * 0.42);
      if (rejBox(foot, [2.2, peakH * 0.4, 2.2], b)) {
        ctx.noteSuppressed("gridshellCanopy", `gridshellCanopy foot SUPPRESSED`);
        return;
      }
      addCyl(out, foot, 0.5, peakH * 0.45, strutCol, 5, b);
    }
    for (let j = 0; j <= rows; j++) {
      const zt = j / rows - 0.5;
      let prev: Vec3 | null = null;
      for (let i = 0; i <= cols; i++) {
        const xt = i / cols - 0.5;
        const arch = Math.cos(xt * Math.PI) * 0.55 + 0.45;   // peak at centre
        const lift = peakH * arch * (0.75 + 0.25 * Math.cos(zt * Math.PI));
        const node = vadd(vadd(vadd(c, u, lift), r, xt * w), f, zt * depth);
        const col = ledCols[(i + j) % ledCols.length]!;
        overheadBox(node, [2.2, 1.2, 2.0], col, b);
        if (prev) {
          const pv: Vec3 = prev;
          const mid: RVec3 = [(pv[0] + node[0]) / 2, (pv[1] + node[1]) / 2, (pv[2] + node[2]) / 2];
          const span = Math.hypot(node[0] - pv[0], node[1] - pv[1], node[2] - pv[2]) || 1;
          overheadBox(mid, [0.35, 0.35, span], strutCol, b);
        }
        prev = node;
      }
    }
  };

  // identity.js:255-282.
  const runoffApron = (k: number, side: number, gap: number, sz: RVec3 | number | null | undefined, col?: RVec3 | null): void => {
    let depth: number, thick: number, len: number;
    if (isVec(sz)) { depth = sz[0]; thick = sz[1] != null ? sz[1] : 0.35; len = sz[2] != null ? sz[2] : 24; }
    else { depth = sz || 18; thick = 0.35; len = 24; }
    const dist = gap + depth / 2;
    const a = anchor(k, side, dist), b: Basis = [a.r, a.u, a.t];
    // A painted surface: sample the ground at both edges and the centre so
    // neither edge floats or buries (identity.js:261-266).
    const gy = (d: number) => anchor(k, side, d).c[1] + 0.3;
    const g0 = gy(gap), g1 = a.c[1] + 0.3, g2 = gy(gap + depth);
    const top = Math.max(g0, g1, g2) + 0.03, h = Math.max(thick, top - Math.min(g0, g1, g2) + 0.05);
    // Over the tarmac, fall back to the slab and its old guard (identity.js:270-272).
    let box: RVec3 = [depth, h, len], c = vadd(a.c, a.u, top - h / 2 - a.c[1]);
    if (rejBox(c, box, b)) {
      box = [depth, thick, len]; c = vadd(a.c, a.u, thick / 2);
      if (rejBox(a.c, box, b)) {
        ctx.noteSuppressed("runoffApron", `runoffApron SUPPRESSED at k=${k} side=${side}: gap=${gap}`);
        return;
      }
    }
    addBox(out, c, box, col || [0.42, 0.40, 0.38], b);
  };

  // identity.js:284-319.
  const bankedKerbStrip = (s0: number, s1: number, side: number, opts?: BankedKerbStripOpts | null): void => {
    const o: BankedKerbStripOpts = opts || {};
    const kerbRed: RVec3 = o.kerbRed || [0.86, 0.12, 0.14];
    const kerbWht: RVec3 = o.kerbWht || [0.94, 0.94, 0.92];
    const saferCol: RVec3 = o.saferCol || [0.76, 0.78, 0.80];
    const saferGap = o.saferGap != null ? o.saferGap : 7.0;
    const doSafer = o.safer !== false;
    let stripe = 0;
    along(s0, s1, o.step || 3.2, (k, spacing) => {
      const col = (stripe++ & 1) ? kerbWht : kerbRed;
      const a = anchor(k, side, 1.35);
      if (onTrack(a.c[0], a.c[2], 1.1)) return;
      const b: Basis = [a.r, a.u, a.t];
      const SINK = 0.3;
      addBox(out, vadd(a.c, a.u, 0.16 + SINK), [1.05, 0.26, spacing * 0.90], col, b);
      // INSET, not flush: 65 mm behind the slab edge (identity.js:299-305).
      addBox(out, vadd(vadd(a.c, a.r, side * 0.30), a.u, 0.30 + SINK),
             [0.32, 0.42, spacing * 0.90], col, b);
    });
    if (!doSafer) return;
    along(s0, s1, o.saferStep || 4.0, (k, spacing) => {
      const a = anchor(k, side, saferGap);
      if (onTrack(a.c[0], a.c[2], 1.4)) return;
      const b: Basis = [a.r, a.u, a.t];
      addBox(out, vadd(a.c, a.u, 0.55), [0.58, 1.10, spacing * 0.94], saferCol, b);
      addBox(out, vadd(a.c, a.u, 1.14), [0.62, 0.12, spacing * 0.94], kerbRed, b);
      addCyl(out, vadd(a.c, a.r, side * 0.42), 0.10, 1.25,
             [0.34, 0.34, 0.37], 5, b);
    });
  };

  // identity.js:321-344.
  const bowlSeatWall = (s0: number, s1: number, side: number, gap: number, opts?: BowlSeatWallOpts | null): void => {
    opts = opts || {};
    const h = opts.h != null ? opts.h : 5.8;
    const thick = opts.thick != null ? opts.thick : 3.4;
    const shell: RVec3 = opts.shell || [0.55, 0.54, 0.56];
    const crowdCols: readonly RVec3[] = opts.crowdCols || [
      [0.92, 0.28, 0.55], [0.95, 0.45, 0.12], [0.18, 0.72, 0.42],
      [0.98, 0.82, 0.10], [0.94, 0.94, 0.92], [0.22, 0.42, 0.78], [0.90, 0.30, 0.24],
    ];
    // Solid seating mass — index it so foliage cannot grow through the bowl.
    indexSolid(s0, s1, side, gap - thick / 2, thick);
    along(s0, s1, opts.step || 7, (k, spacing) => {
      const p = anchor(k, side, gap);
      if (onTrack(p.c[0], p.c[2], thick / 2 + 2)) return;
      const bv: Basis = [p.r, p.u, p.t];
      addBox(out, vadd(p.c, p.u, h * 0.48), [thick, h * 0.95, spacing * 0.94], shell, bv);
      // Crowd face stands 6 cm proud where it would meet the shell face (identity.js:337-338).
      const crowdOff = thick * 0.38 + (Math.abs(thick * 0.38 + 0.275 - thick / 2) < 0.05 ? 0.06 : 0);
      addBox(out, vadd(vadd(p.c, p.u, h * 0.55), p.r, -side * crowdOff),
             [0.55, h * 0.72, spacing * 0.88],
             crowdCols[Math.floor(hash(k * 11 + side) * crowdCols.length) % crowdCols.length]!, bv);
    });
  };

  // identity.js:346-420.
  const broadcastCompound = (k: number, side: number, gap: number, opts?: BroadcastCompoundOpts | null): void => {
    opts = opts || {};
    const vans = Math.max(1, Math.min(8, Math.round(opts.vans != null ? opts.vans : 3)));
    const dishes = Math.max(0, Math.min(6, Math.round(opts.dishes != null ? opts.dishes : 2)));
    const spacing = opts.spacing != null ? opts.spacing : 4.6;
    const vanCol: RVec3 = opts.vanCol || [0.82, 0.83, 0.86];
    const dishCol: RVec3 = opts.dishCol || [0.90, 0.90, 0.92];
    const dark: RVec3 = [0.20, 0.21, 0.24];
    const p = anchor(k, side, gap), b: Basis = [p.r, p.u, p.t];
    const span = vans * spacing + dishes * 3.4 + 2;
    const mastH = opts.mastH != null ? opts.mastH : 9;
    if (rejBox(vadd(p.c, p.u, mastH / 2), [9, mastH, span], b)) {
      ctx.noteSuppressed("broadcastCompound", `broadcastCompound SUPPRESSED at k=${k} side=${side}: gap=${gap}`);
      return;
    }
    // Each piece is seated on the terrain under its own spot when that is
    // below the compound's one anchor point (identity.js:361-368).
    const seatAt = (c: RVec3, hr: number, ht: number): RVec3 => {
      if (!ctx.terrainYAt) return c;
      let lo = Infinity;
      for (const q of [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        const x = c[0] + p.r[0] * q[0] * hr + p.t[0] * q[1] * ht;
        const z = c[2] + p.r[2] * q[0] * hr + p.t[2] * q[1] * ht;
        const g = ctx.terrainYAt(x, z);
        if (g != null && g < lo) lo = g;
      }
      return lo === Infinity ? c : [c[0], Math.min(c[1], lo - 0.3), c[2]];
    };
    const start = out.pos.length;
    let trucks = 0;
    // OB truck row — box body on a darker chassis band, parked nose-in.
    for (let i = 0; i < vans; i++) {
      const off = (i - (vans - 1) / 2) * spacing;
      const c = seatAt(vadd(p.c, p.t, off), 0, 0);   // centre only (see seatAt)
      if (addBox(out, vadd(c, p.u, 1.95), [7.2, 3.1, 2.5], vanCol, b) === false) continue;
      trucks++;
      addBox(out, vadd(c, p.u, 0.42), [7.0, 0.7, 2.6], dark, b);
      // roof AC/cable box, so the row is not four identical bricks
      if (hash(k * 3.1 + i * 5.7 + side) > 0.45)
        addBox(out, vadd(vadd(c, p.u, 3.7), p.r, side * 1.2), [1.6, 0.5, 1.0], dark, b);
    }
    if (!trucks) return;
    // Uplink dishes, set behind the trucks.
    for (let i = 0; i < dishes; i++) {
      const off = (i - (dishes - 1) / 2) * 3.4 + (vans * spacing) / 2 + 2.2;
      const base = seatAt(vadd(vadd(p.c, p.t, off), p.r, side * 3.4), 1.0, 1.0);
      addBox(out, vadd(base, p.u, 0.5), [2.0, 1.0, 2.0], dark, b);          // skid
      // Pedestal rises out of the skid to the dish (identity.js:399-401).
      addCyl(out, vadd(base, p.u, 0.9), 0.18, 1.8, [0.42, 0.43, 0.46], 6, b); // pedestal
      const dc = vadd(base, p.u, 2.5);
      const tilt: RVec3 = [p.u[0] * 0.72 + p.r[0] * side * 0.69,
                           p.u[1] * 0.72,
                           p.u[2] * 0.72 + p.r[2] * side * 0.69];
      addFrustum(out, dc, 1.45, 0.5, 0.55, dishCol, 9, [p.r, tilt, p.t]);
      // Feed horn on a boom out to the focus (identity.js:408-410).
      addCyl(out, vadd(dc, tilt, 0.3), 0.12, 1.1, dark, 5, [p.r, tilt, p.t]);  // feed horn
    }
    // Link mast with a warning lamp — the compound's vertical accent.
    const mast = seatAt(vadd(vadd(p.c, p.t, -(vans * spacing) / 2 - 1.6), p.r, side * 2.6), 0.16, 0.16);
    addCyl(out, vadd(mast, p.u, -0.4), 0.16, mastH + 0.8, [0.46, 0.47, 0.50], 5, b);
    addBox(out, vadd(mast, p.u, mastH), [0.9, 0.35, 0.7], dark, b);
    addBox(out, vadd(mast, p.u, mastH + 0.4), [0.26, 0.26, 0.26],
           NIGHT ? [1.60, 0.28, 0.20] : [0.72, 0.16, 0.12], b);
    ctx.reserveEmittedSolid(out, start, b);
  };

  // identity.js:422-440.
  const pastelStreetRow = (s0: number, s1: number, side: number, gap: number, opts?: PastelStreetRowOpts | null): void => {
    const o: PastelStreetRowOpts = opts || {};
    const pal: readonly RVec3[] = o.palette || [[0.92, 0.86, 0.72], [0.86, 0.72, 0.48]];
    const minH = o.minH != null ? o.minH : 12;
    const maxH = o.maxH != null ? o.maxH : 22;
    const depth = o.depth != null ? o.depth : 10;
    const step = o.step != null ? o.step : 40;
    const win: RVec3 = o.window || [0.35, 0.42, 0.52];
    along(s0, s1, step, (k) => {
      const hv = hash(k * 5.3 + side * 0.9);
      const w = 10 + hv * 8;
      const h = minH + hash(k * 9.1 + side) * (maxH - minH);
      const g = gap + hash(k * 2.7) * 1.5;
      building(k, side, g, w, h, depth,
        { wall: pal[Math.floor(hash(k * 3.1) * pal.length) % pal.length],
          window: win, floor: o.floor != null ? o.floor : (3.5 + hv),
          lit: o.lit !== false, windowCol: o.windowCol || [0.95, 0.88, 0.55] });
    });
  };

  return { underpassPortal, floodMast, floodMastRing, ledFacadeBands,
           concreteCanyon, sailCanopy, gridshellCanopy, runoffApron,
           bankedKerbStrip, bowlSeatWall, pastelStreetRow, broadcastCompound };
}
