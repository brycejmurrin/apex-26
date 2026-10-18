/**
 * SceneryGuards: the road / pit-complex guards of the props build
 * (`onRoadHit`, `rejBox`, `rejRad`, `onTrack`). `create(ctx)` closes over the
 * track's node arrays and the shared node grid; `pitRejected()` reads the flag
 * the last guard call set (a rejected model is "superseded" when the hit was
 * the pit complex, not the road).
 *
 * Port of f1-game js/track/scenery/guards.js:1-191 (`SceneryGuards`),
 * verbatim apart from types. No engine globals. build-props.js:462 creates it.
 */
import type { Basis, RVec3 } from "../../contracts/scenery";
import type { NodeGrid } from "./core";

/** The pit-complex layout fields the guards read (`track.pit`, f1-game js/track/core/pit.js). */
export interface GuardsPit {
  /** Per node: the complex's lateral reach beyond `hw` on the pit side (0 = not a pit node). */
  readonly keep: ArrayLike<number>;
  /** -1 left / +1 right. */
  readonly side: number;
  /** Per node: the lane's blend weight (scales `off.fastIn`). */
  readonly v: ArrayLike<number>;
  readonly bands: { readonly verge: number };
  readonly off: { readonly fastIn: number };
}

/** The track fields the guards read beyond the ctx arrays. */
export interface GuardsTrack {
  readonly rx: Float32Array;
  readonly rz: Float32Array;
  readonly tx: Float32Array;
  readonly tz: Float32Array;
  readonly pit?: GuardsPit | null;
}

/** `create`'s ctx (build-props.js:462). */
export interface GuardsCtx {
  readonly track: GuardsTrack;
  readonly n: number;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly hw: Float32Array;
  readonly ds: number;
  readonly grid: NodeGrid;
}

/** The guards `create` returns (guards.js:186). */
export interface GuardsApi {
  readonly pitKeep: ArrayLike<number> | null;
  readonly pitSide: number;
  inPitFootprint(k: number, lat: number, halfLat: number, outerMargin?: number): boolean;
  onRoadHit(
    cx: number, cz: number, topY: number, rad: number,
    arx: number, arz: number, afx: number, afz: number, hx: number, hz: number, botY?: number,
  ): boolean;
  rejBox(c: RVec3, sz: RVec3, basis?: Basis | null): boolean;
  rejRad(c: RVec3, rad: number, h: number, basis?: Basis | null, crown?: boolean): boolean;
  onTrack(x: number, z: number, margin: number, pitMargin?: number): boolean;
  pitRejected(): boolean;
}

export function create(ctx: GuardsCtx): GuardsApi {
  const { track, n, px, py, pz, hw, ds, grid } = ctx;
  const _hitCand = new Array<number>(n), _trkCand = new Array<number>(n);   // reusable query scratch
  // guards.js:11-15: THE PIT COMPLEX IS ROAD to the guards: on the pit side,
  // across the window, a node's half-width grows by the complex's footprint,
  // so no prop can be placed on the lane, the wall, the apron or the garages.
  // The complex's own furniture (SceneryPits) uses the RAW emitters.
  const pitKeep = track.pit ? track.pit.keep : null, pitSide = track.pit ? track.pit.side : 0;
  const pitV = track.pit ? track.pit.v : null, pitVerge = track.pit ? track.pit.bands.verge : 0;
  const pitMax = (() => { let m = 0; if (pitKeep) for (let k = 0; k < n; k++) if (pitKeep[k]! > m) m = pitKeep[k]!; return m; })();
  // guards.js:19-27: pay the wide (pit) query radius only where the query can
  // reach a pit node at all: its circle plus a grid cell's diagonal against
  // the pit nodes' bounding box. Byte-identical on all 52 circuits.
  const pitBox = (() => {
    if (!pitKeep || !(pitMax > 0)) return null;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let k = 0; k < n; k++) if (pitKeep[k]! > 0) {
      if (px[k]! < x0) x0 = px[k]!; if (px[k]! > x1) x1 = px[k]!;
      if (pz[k]! < z0) z0 = pz[k]!; if (pz[k]! > z1) z1 = pz[k]!;
    }
    return x0 <= x1 ? { x0, x1, z0, z1 } : null;
  })();
  const _pitRect = pitBox ? [pitBox.x0, pitBox.x1, pitBox.z0, pitBox.z1] : null, _rectA = [0, 0, 0, 0];
  const PIT_GATE_PAD = 15;
  const nearPit = (x: number, z: number, r: number) => !!pitBox && x + r + PIT_GATE_PAD >= pitBox.x0 && x - r - PIT_GATE_PAD <= pitBox.x1 &&
    z + r + PIT_GATE_PAD >= pitBox.z0 && z - r - PIT_GATE_PAD <= pitBox.z1;
  // The complex's footprint at node k as a lateral RANGE on the pit side,
  // [beyond the verge, its far edge]: the verge itself stays placeable.
  const pitFastIn = track.pit ? track.pit.off.fastIn : 0;
  const inPitFootprint = (k: number, lat: number, halfLat: number, outerMargin?: number) => {
    if (!pitKeep || !(pitKeep[k]! > 0)) return false;
    // guards.js:48-55: the verge AND the platform stay placeable; `outerMargin`
    // is a clearance from the OUTER edge only (clearTreeDist's crown radius).
    const a0 = hw[k]! + Math.max(pitVerge, pitFastIn * pitV![k]!) + 0.3, a1 = hw[k]! + pitKeep[k]!;
    const c = lat * pitSide;
    return c + halfLat > a0 && c - halfLat - (outerMargin || 0) < a1;
  };
  // Set by onRoadHit when the hit was the PIT COMPLEX rather than the road,
  // so a rejected model can be recorded as superseded (guards.js:60-63).
  let _pitReject = false;
  const onRoadHit = (
    cx: number, cz: number, topY: number, rad: number,
    arx: number, arz: number, afx: number, afz: number, hx: number, hz: number, botY?: number,
  ) => {
    const mhFull = grid.maxHw + pitMax;
    const rFull = (rad > 0 ? rad + mhFull : Math.hypot(hx + mhFull, hz + mhFull)) + 2;
    const mh = nearPit(cx, cz, rFull) ? mhFull : grid.maxHw;
    // guards.js:69-75: the complex keeps FOOTINGS out, not a crown: a RADIAL
    // primitive whose underside is well above the road may reach over the
    // complex's edge. Boxes never get the exemption.
    const R = (rad > 0 ? rad + mh : Math.hypot(hx + mh, hz + mh)) + 2;
    let _cn;
    if (rad > 0) _cn = grid.query(cx, cz, R, _hitCand, false);
    else {
      // guards.js:80-86: a BOX hits the road only at a node e with
      // |e·r| <= hx + w and |e·f| <= hz + w; inverting that 2x2 bounds |ex|,
      // |ez|. The query keeps the strip's cells UNION pitBox's, in query()'s
      // order, so the first hit (and _pitReject) is unchanged.
      const det = Math.abs(arx * afz - arz * afx), A = hx + grid.maxHw, B = hz + grid.maxHw;
      let ex = det > 1e-6 ? (Math.abs(afz) * A + Math.abs(arz) * B) / det + 1 : R;
      let ez = det > 1e-6 ? (Math.abs(afx) * A + Math.abs(arx) * B) / det + 1 : R;
      if (!(ex < R)) ex = R; if (!(ez < R)) ez = R;
      _rectA[0] = cx - ex; _rectA[1] = cx + ex; _rectA[2] = cz - ez; _rectA[3] = cz + ez;
      _cn = grid.queryRects(cx, cz, R, _rectA, _pitRect, _hitCand);
    }
    for (let _ci = 0; _ci < _cn; _ci++) {
      const k = _hitCand[_ci]!;
      if (topY < py[k]! - 0.3) continue;                 // sits below road here
      const w = hw[k]!;
      // `botY` may be undefined (rejBox): `undefined > x` is false, as in f1-game.
      if (pitKeep && pitKeep[k]! > 0 && !(botY! > py[k]! + 2.5)) {
        // The pit complex: the footprint's lateral reach at this node against
        // the complex's range, provided the node lies along the footprint.
        const lat = (cx - px[k]!) * track.rx[k]! + (cz - pz[k]!) * track.rz[k]!;
        const along = (cx - px[k]!) * track.tx[k]! + (cz - pz[k]!) * track.tz[k]!;
        const halfLat = rad > 0 ? rad : Math.abs(arx * track.rx[k]! + arz * track.rz[k]!) * hx + Math.abs(afx * track.rx[k]! + afz * track.rz[k]!) * hz;
        const halfAlong = rad > 0 ? rad : Math.abs(arx * track.tx[k]! + arz * track.tz[k]!) * hx + Math.abs(afx * track.tx[k]! + afz * track.tz[k]!) * hz;
        if (Math.abs(along) <= halfAlong + ds && inPitFootprint(k, lat, halfLat)) { _pitReject = true; return true; }
      }
      const dxc = px[k]! - cx, dzc = pz[k]! - cz;
      // guards.js:108-113: the far-reject reach uses the EXPANDED half-extents
      // (a thin box's hit corner can sit at hypot(hx+w, hz+w) from centre).
      const reach = (rad > 0 ? rad + w : Math.hypot(hx + w, hz + w)) + 2;
      if (dxc * dxc + dzc * dzc > reach * reach) continue;   // cheap far reject
      const ex = px[k]! - cx, ez = pz[k]! - cz;
      if (rad > 0) {
        // circle footprint vs road capsule of radius w
        const rr = rad + w;
        if (ex * ex + ez * ez <= rr * rr) return true;
      } else {
        // oriented rectangle expanded by w on each axis
        const a = Math.abs(ex * arx + ez * arz), b = Math.abs(ex * afx + ez * afz);
        if (a <= hx + w && b <= hz + w) return true;
      }
    }
    return false;
  };
  const rejBox = (c: RVec3, sz: RVec3, basis?: Basis | null) => {
    _pitReject = false;
    const r: RVec3 = basis ? basis[0] : [1, 0, 0], u: RVec3 = basis ? basis[1] : [0, 1, 0], f: RVec3 = basis ? basis[2] : [0, 0, 1];
    const topY = c[1] + Math.abs(sz[0] / 2 * r[1]) + Math.abs(sz[1] / 2 * u[1]) + Math.abs(sz[2] / 2 * f[1]);
    return onRoadHit(c[0], c[2], topY, 0, r[0], r[2], f[0], f[2], sz[0] / 2, sz[2] / 2);
  };
  const rejRad = (c: RVec3, rad: number, h: number, basis?: Basis | null, crown?: boolean) => {
    _pitReject = false;
    const u: RVec3 = basis ? basis[1] : [0, 1, 0];
    const topY = c[1] + Math.max(0, h * u[1]) + rad;     // generous top estimate
    // guards.js:139-143: a CROWN (cone, frustum) hands its underside (the base
    // centre) over so it may reach over the complex's edge; a cylinder is a
    // footing.
    return onRoadHit(c[0], c[2], topY, rad, 0, 0, 0, 0, 0, 0, crown ? c[1] + Math.min(0, h * u[1]) : undefined);
  };
  const onTrack = (x: number, z: number, margin: number, pitMargin?: number) => {
    _pitReject = false;
    const rFull = grid.maxHw + pitMax + margin + ds + 1;
    const R = nearPit(x, z, rFull) ? rFull : grid.maxHw + margin + ds + 1;
    const _cn = grid.query(x, z, R, _trkCand, false);
    for (let _ci = 0; _ci < _cn; _ci++) {
      const i = _trkCand[_ci]!;
      const j = (i + 1) % n;
      const dx = px[j]! - px[i]!, dz = pz[j]! - pz[i]!;
      const len2 = dx * dx + dz * dz;
      if (len2 < 0.01) continue;
      const t = Math.max(0, Math.min(1, ((x - px[i]!) * dx + (z - pz[i]!) * dz) / len2));
      const cx = px[i]! + t * dx, cz = pz[i]! + t * dz;
      const lat = Math.hypot(x - cx, z - cz);
      const hwt = hw[i]! + (hw[j]! - hw[i]!) * t;
      if (lat < hwt + margin) return true;
      if (pitKeep && pitKeep[i]! > 0) {
        // guards.js:163-168: the POINT against the complex (not point plus
        // road margin), and only where it lies ALONGSIDE this node.
        const al = (x - px[i]!) * track.tx[i]! + (z - pz[i]!) * track.tz[i]!;   // along, from node i
        if (al >= -ds && al <= ds) {
          const sl = (x - px[i]!) * track.rx[i]! + (z - pz[i]!) * track.rz[i]!;   // signed lateral
          // guards.js:172-177: the caller's road margin counts on the OUTER
          // edge too, capped at 3 m.
          const outer = Math.max(pitMargin || 0, Math.min(margin || 0, 3));
          if (inPitFootprint(i, sl, 0, outer)) { _pitReject = true; return true; }
        }
      }
    }
    return false;
  };

  return { pitKeep, pitSide, inPitFootprint, onRoadHit, rejBox, rejRad, onTrack, pitRejected: () => _pitReject };
}
