// Wheel geometry and its rotating/fixed layers; create() receives the shared primitive
// builders and palette references. Ported verbatim from f1-game js/car/car-wheels.js:4-521.
// f1-game reads the optional `CarShade` global (typeof-guarded) for tread normals; here
// it is the optional `shade` dependency, absent = the undefined-global branch.
import type { CarGeometry, Station } from "./geometry";
import type { Surfaces } from "./materials";
import type { CarShadeApi } from "./shade";
import type { MVec3, MeshOut, Vec3 } from "./types";

/** Resolved livery wheel tints (car-wheels.js:10). `key` joins every wheel mesh cache key. */
export interface WheelTints { readonly rim: MVec3 | null; readonly cal: MVec3 | null; readonly ink: MVec3 | null; readonly key: string }

// LIVERY WHEEL TINTS (livery rimTint / caliperTint / sidewallInk, car-wheels.js:5): paint-only
// overrides of the brakes catalog colours for ALL four wheels. A field is a [r,g,b] 0..1 array
// (resolved livery) or "#rrggbb". Unset = NO_TINTS = the catalog colour. `key` is "" when
// nothing is set (keys stay byte-identical).
const _tintMemo = new WeakMap<object, WheelTints>();
const NO_TINTS: WheelTints = Object.freeze({ rim: null, cal: null, ink: null, key: "" });
function tintColour(v: unknown): MVec3 | null {
  if (!v) return null;
  if (Array.isArray(v)) return v.length >= 3 && v.slice(0, 3).every(Number.isFinite) ? [v[0], v[1], v[2]] : null;
  const m = typeof v === "string" && /^#?([0-9a-f]{6})$/i.exec(v);
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}
const q255 = (c: Vec3 | null) => c ? c.map((x) => Math.round(x * 255)).join(",") : "";
/** car-wheels.js:20. Memoised per livery object. */
export function tints(liv: unknown): WheelTints {
  if (!liv || typeof liv !== "object") return NO_TINTS;
  let t = _tintMemo.get(liv);
  if (t) return t;
  const l = liv as { rimTint?: unknown; caliperTint?: unknown; sidewallInk?: unknown };
  const rim = tintColour(l.rimTint), cal = tintColour(l.caliperTint), ink = tintColour(l.sidewallInk);
  t = !rim && !cal && !ink ? NO_TINTS : Object.freeze({ rim, cal, ink, key: "|w" + q255(rim) + ";" + q255(cal) + (ink ? ";" + q255(ink) : "") });
  _tintMemo.set(liv, t);
  return t;
}

type Num = number | null | undefined;
/** Tyre recipe keys addWheel reads (truthy flags stay `unknown`, as f1-game tests them). */
export interface TyreStyle {
  cover?: unknown; shoulder?: Num; grooves?: Num; grooveDepth?: Num; bandWidth?: Num; sidewall?: Num;
  coverVanes?: Num; nut?: Vec3 | null | undefined; gunNut?: unknown; spokes?: Num; dish?: Num;
}
/** Brakes recipe keys addWheel reads. */
export interface BrakeStyle {
  coverOpen?: Num; rotorScale?: Num; caliperPos?: Num; rotor?: Num; discFace?: Num; duct?: Num; caliper?: Num;
}
/** Wheel recipe keys addWheel reads. */
export interface WheelStyle {
  cover?: unknown; nut?: Vec3 | null | undefined; gunNut?: unknown; spokes?: Num; tape?: unknown; dish?: Num;
}
type Col = Vec3 | null | undefined;
type Style<T> = T | null | undefined;

/** What create() needs (car3d.js:102): the primitives and palette identities, plus the
 *  optional shade module (f1-game's typeof-guarded `CarShade` global). */
export interface CarWheelsDeps {
  geometry: Pick<CarGeometry, "addTri" | "addQuad" | "addBox" | "addSpan">;
  SURFACES: Surfaces;
  TYRE: Vec3;
  INTAKE: Vec3;
  shade?: Pick<CarShadeApi, "any" | "vertexNormals"> | undefined;
}

export function create(context: CarWheelsDeps) {
  const { SURFACES, TYRE, INTAKE, shade } = context;
  const { addTri, addQuad, addBox, addSpan } = context.geometry;

  // Wheel face profile (car-wheels.js:33). 2026 regs dropped the aero dish: the DEFAULT
  // wheel is an open rim (lip + spokes + centre-lock nut, brake disc visible through the
  // gaps). The 2022–25 three-ring COVER is opt-in only — `tyreStyle.cover` or
  // `wheelStyle.cover` (truthy). `coverVanes` alone must NOT build a cover.
  // Value ORDER on a covered face: bright machined rim around a DARK dish — the other
  // way up reads as a road-car hubcap under a studio key.
  const LIP: Vec3      = [0.40, 0.41, 0.44];     // machined rim, the brightest ring
  const COVER: Vec3    = [0.24, 0.245, 0.27];    // dish wall (cover path only)
  const COVER_IN: Vec3 = [0.14, 0.14, 0.16];     // its floor, deepest in shadow
  const LIP_R  = 0.90;    // rim lip runs rimR*0.90 .. rimR
  const DISH_R = 0.40;    // dish wall ends here, where the hubcap starts
  const DISH_D = 0.050;   // recessed inboard — 50 mm so the bowl reads in the garage
  // Default open spoke count when recipe leaves spokes:0. Must stay well below catalog
  // 6-spoke options so parts-sweep's WEAK_MM (20 mm) Hausdorff still separates them.
  const OPEN_SPOKES = 3;

  // car-wheels.js:51
  function addWheel(out: MeshOut, cx: number, cy: number, cz: number, r: number, w: number, bandColor: Col, caliperColor: Col,
                    rimColor: Col, grooved: unknown, tyreStyle: Style<TyreStyle>, fixedOut: MeshOut | null | undefined,
                    brakeStyle: Style<BrakeStyle>, wheelStyle: Style<WheelStyle>, inkColor?: Col): void {
    // `rimColor` is the brakes recipe's `rim` key; the rim faces below take RC. RIM_DEF
    // reproduces the old hardcoded value, so a car with no `rim` set is byte-identical.
    const RIM_DEF: Vec3 = [0.31, 0.31, 0.34];
    const RC = rimColor || RIM_DEF;
    const RC_DEEP: Vec3 = [RC[0] * 0.39, RC[1] * 0.39, RC[2] * 0.41];   // dish floor, in shadow
    // 18 -> 24: an 18-gon tyre reads visibly polygonal in any close shot.
    const SEG = 24, rw = shade !== undefined && shade.any();   // rw: tread normals from its real shape (./shade)
    const x0 = cx - w/2, x1 = cx + w/2;
    const rimR = r * 0.68;
    const coverOpen = brakeStyle && brakeStyle.coverOpen || 0;
    // Explicit cover flag only — never infer from coverVanes / dish / spokes.
    const useCover = !!(tyreStyle && tyreStyle.cover) || !!(wheelStyle && wheelStyle.cover);
    const rotorScale = brakeStyle && brakeStyle.rotorScale || 1;
    const tyreShoulder = Math.max(0, Math.min(2, Math.round((tyreStyle && tyreStyle.shoulder) || 0)));
    // A real slick's shoulder rounds over roughly the outer 30 mm of a 355 mm tread and
    // gives up ~12 mm of its 360 mm radius doing it: 0.966 of r over 0.075 of the width is
    // that measurement at this model's scale. The `shoulder` knob's tiers (0.920 / 0.874,
    // wider rolls) are each ~15 mm of radius and ~8 mm of surface, over the 5 mm optical floor.
    const TYRE_CROWN = 0.948, CROWN_W = 0.090;
    const SH1 = 0.920, SH1_W = 0.11, SH2 = 0.874, SH2_W = 0.15;
    const edgeRm = tyreShoulder === 2 ? SH2 : tyreShoulder === 1 ? SH1 : TYRE_CROWN;
    const grooveCount = tyreStyle && tyreStyle.grooves != null
      // `grooved` is the legacy BOOLEAN ARGUMENT, kept for callers that build a wheel with
      // no recipe at all (Car3D.buildWheel(0.34, band)). It is no longer a recipe key.
      ? tyreStyle.grooves : grooved ? 3 : 0;
    const grooveDepth = tyreStyle && tyreStyle.grooveDepth || 0.045;
    const PROFILE: [number, number][] = [];
    if (tyreShoulder === 1) {
      PROFILE.push([0, SH1], [SH1_W, 1]);
    } else if (tyreShoulder === 2) {
      PROFILE.push([0, SH2], [SH2_W, 1]);
    } else {
      PROFILE.push([0, TYRE_CROWN], [CROWN_W, 1]);
    }
    for (let g = 0; g < grooveCount; g++) {
      const mid = (g + 1) / (grooveCount + 1);
      PROFILE.push([mid - 0.025, 1], [mid, 1 - grooveDepth], [mid + 0.025, 1]);
    }
    if (tyreShoulder === 1) {
      PROFILE.push([1 - SH1_W, 1], [1, SH1]);
    } else if (tyreShoulder === 2) {
      PROFILE.push([1 - SH2_W, 1], [1, SH2]);
    } else {
      PROFILE.push([1 - CROWN_W, 1], [1, TYRE_CROWN]);
    }
    const i0 = out.pos.length / 3;
    for (const [xf, rm] of PROFILE) {
      const x = x0 + (x1 - x0) * xf, rr = r * rm;
      for (let i = 0; i < SEG; i++) {
        const a = (i / SEG) * Math.PI * 2;
        const c = Math.cos(a), s = Math.sin(a);
        out.pos.push(x, cy + rr * c, cz + rr * s);
        out.nrm.push(0, c, s);
        out.col.push(TYRE[0], TYRE[1], TYRE[2]);
        out.mat.push(SURFACES.rubber);
      }
    }
    for (let ri = 0; ri < PROFILE.length - 1; ri++) {
      for (let i = 0; i < SEG; i++) {
        const i2 = (i + 1) % SEG;
        const A = i0 + ri*SEG + i, B = i0 + ri*SEG + i2, C = i0 + (ri+1)*SEG + i2, D = i0 + (ri+1)*SEG + i;
        out.idx.push(A, B, C, A, C, D);
      }
    }
    if (rw) shade.vertexNormals(out, i0, out.pos.length / 3);
    const outerR = r * edgeRm;
    for (let i = 0; i < SEG; i++) {
      const a0 = (i / SEG) * Math.PI * 2, a1 = ((i+1) / SEG) * Math.PI * 2;
      const ya0 = cy + outerR*Math.cos(a0), za0 = cz + outerR*Math.sin(a0);
      const ya1 = cy + outerR*Math.cos(a1), za1 = cz + outerR*Math.sin(a1);
      const rya0 = cy + rimR*Math.cos(a0), rza0 = cz + rimR*Math.sin(a0);
      const rya1 = cy + rimR*Math.cos(a1), rza1 = cz + rimR*Math.sin(a1);
      const A0: Vec3=[x0,ya0,za0], A1: Vec3=[x0,ya1,za1], B0: Vec3=[x1,ya0,za0], B1: Vec3=[x1,ya1,za1];
      const R0: Vec3=[x1,rya0,rza0], R1: Vec3=[x1,rya1,rza1];
      // SINGLE face per wall (no coincident duplicate). The wheel is drawn CULL-OFF
      // (double-sided), so each single face shows from BOTH sides with nothing to
      // z-fight — double-wound coincident faces flickered on mobile depth precision.
      addQuad(out, B0, B1, R1, R0, TYRE, SURFACES.rubber);
      const L0: Vec3=[x0,rya0,rza0], L1: Vec3=[x0,rya1,rza1];
      addQuad(out, A0, A1, L1, L0, TYRE, SURFACES.rubber);
      // Rim face. Cover path: three rings (lip / dish / floor) with coverOpen and
      // caliper-clock peeks so brakes show through. Open path (default): lip annulus
      // only — spokes + hub nut fill the face; coverOpen is a no-op with no cover.
      const aMid = (i + 0.5) / SEG * Math.PI * 2;
      const calClock = brakeStyle && brakeStyle.caliperPos || 0;
      const peekCal = Math.abs(Math.atan2(Math.sin(aMid - calClock), Math.cos(aMid - calClock))) < 0.28;
      const coverSeg = useCover && (!coverOpen || i % (coverOpen >= 2 ? 2 : 3) !== 0) && !peekCal;
      if (coverSeg || !useCover) {
        for (const sd of [[x1, 1], [x0, -1]] as const) {
          const xw = sd[0], dir = sd[1];
          const P = (rad: number, a: number, dx: number): Vec3 => [xw + dir * dx,
            cy + rad * Math.cos(a), cz + rad * Math.sin(a)];
          // 1. rim lip: bright annulus at the wall plane (both paths).
          addQuad(out, P(rimR, a0, 0), P(rimR, a1, 0),
                       P(rimR * LIP_R, a1, 0), P(rimR * LIP_R, a0, 0), LIP, SURFACES.metal);
          if (!useCover) continue;
          // 2. dish: falls INBOARD as it goes in, so the light gradient across it reads
          //    as a bowl rather than a disc.
          addQuad(out, P(rimR * LIP_R, a0, 0), P(rimR * LIP_R, a1, 0),
                       P(rimR * DISH_R, a1, DISH_D), P(rimR * DISH_R, a0, DISH_D),
                       COVER, SURFACES.carbon);
          // 3. floor of the dish, out to the hubcap that already sits on it.
          addTri(out, [xw + dir * DISH_D, cy, cz],
                       P(rimR * DISH_R, a0, DISH_D), P(rimR * DISH_R, a1, DISH_D),
                       COVER_IN, SURFACES.carbon);
        }
      }
    }
    // Cover-only: five raised spoke ribs across each dish, proud of the floor by a third
    // of the dish depth so they catch the key. Open rims use real extruded spokes (below).
    if (useCover) for (const sd of [[x1, 1], [x0, -1]] as const) {
      const xw = sd[0], dir = sd[1];
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2 + 0.31, hw = 0.13;
        const P = (rad: number, aa: number, dx: number): Vec3 => [xw + dir * dx,
          cy + rad * Math.cos(aa), cz + rad * Math.sin(aa)];
        addQuad(out, P(rimR * DISH_R, a - hw, DISH_D * 0.22), P(rimR * DISH_R, a + hw, DISH_D * 0.22),
                     P(rimR * 0.28, a + hw * 1.8, DISH_D * 0.22), P(rimR * 0.28, a - hw * 1.8, DISH_D * 0.22),
                     LIP, SURFACES.metal);
      }
    }
    const rotorOuter = r * Math.min(0.40, 0.32 * rotorScale);
    const rotorInner = r * 0.17;
    const rotorDetail = brakeStyle && brakeStyle.rotor || 0;
    const discFaceRotor = Math.max(0, Math.min(2, Math.round((brakeStyle && brakeStyle.discFace) || 0)));
    const carbonDisc = rotorDetail >= 2 || discFaceRotor > 0;
    const rotorCol: Vec3 = carbonDisc ? [0.12, 0.12, 0.13] : [0.24, 0.24, 0.26];
    const rotorSurf = carbonDisc ? SURFACES.carbon : SURFACES.metal;
    // The disc's EDGE: a cylindrical band between the two faces (a flat annulus has zero
    // silhouette, so `rotorScale` measured WEAK without it).
    for (let i = 0; i < SEG; i++) {
      const a0 = i / SEG * Math.PI * 2, a1 = (i + 1) / SEG * Math.PI * 2;
      const E = (a: number, xx: number): Vec3 => [xx, cy + rotorOuter * Math.cos(a), cz + rotorOuter * Math.sin(a)];
      addQuad(out, E(a0, x0 + 0.008), E(a1, x0 + 0.008), E(a1, x1 - 0.008), E(a0, x1 - 0.008),
        rotorCol, rotorSurf);
    }
    for (const face of [[x0 + 0.008, -1], [x1 - 0.008, 1]] as const) {
      for (let i = 0; i < SEG; i++) {
        const a0 = i / SEG * Math.PI * 2, a1 = (i + 1) / SEG * Math.PI * 2;
        const P = (rad: number, a: number): Vec3 => [face[0], cy + rad*Math.cos(a), cz + rad*Math.sin(a)];
        addQuad(out, P(rotorOuter,a0), P(rotorOuter,a1), P(rotorInner,a1), P(rotorInner,a0),
          rotorCol, rotorSurf);
      }
      for (let i = 0; i < rotorDetail * 3; i++) {
        const a = i / (rotorDetail * 3) * Math.PI * 2, rr = (rotorInner + rotorOuter) * 0.5;
        addBox(out, face[0], cy + rr*Math.cos(a), cz + rr*Math.sin(a),
          0.012, 0.018, 0.018, [0.07,0.07,0.08], SURFACES.carbon);
      }
      if (rotorDetail >= 2) {
        const hatOuter = rotorInner * 1.08, hatInner = rotorInner * 0.52;
        const HAT_SEG = 8;
        for (let i = 0; i < HAT_SEG; i++) {
          const a0 = i / HAT_SEG * Math.PI * 2, a1 = (i + 1) / HAT_SEG * Math.PI * 2;
          const P = (rad: number, a: number): Vec3 => [face[0], cy + rad*Math.cos(a), cz + rad*Math.sin(a)];
          addQuad(out, P(hatOuter,a0), P(hatOuter,a1), P(hatInner,a1), P(hatInner,a0),
            [0.34, 0.34, 0.37], SURFACES.metal);
        }
      }
      if (discFaceRotor > 0) {
        const marks = discFaceRotor === 1 ? 6 : 4;
        const rad = (rotorInner + rotorOuter) * 0.55;
        const sz = discFaceRotor === 1 ? 0.012 : 0.022;
        const slot = discFaceRotor === 1 ? 1 : 0.40;
        for (let k = 0; k < marks; k++) {
          const a = (k / marks) * Math.PI * 2 + 0.14;
          const my = cy + rad * Math.cos(a), mz = cz + rad * Math.sin(a);
          const hy = sz * 0.5, hz = sz * slot * 0.5;
          addQuad(out,
            [face[0], my - hy, mz - hz], [face[0], my - hy, mz + hz],
            [face[0], my + hy, mz + hz], [face[0], my + hy, mz - hz],
            INTAKE, SURFACES.carbon);
        }
      }
    }
    // The band is always the compound colour (it is how a tyre reads at a glance);
    // livery sidewallInk paints the lettering rings below.
    const BAND = bandColor || [0.85, 0.10, 0.08];
    const bandWidth = tyreStyle && tyreStyle.bandWidth != null ? tyreStyle.bandWidth : 0.09;
    for (const bs of [[x0, -1], [x1, 1]] as const) {
      const xb = bs[0] + bs[1] * 0.004;
      for (let i = 0; i < SEG; i++) {
        const a0 = (i / SEG) * Math.PI * 2, a1 = ((i + 1) / SEG) * Math.PI * 2;
        const P = (rad: number, a: number): Vec3 => [xb, cy + rad * Math.cos(a), cz + rad * Math.sin(a)];
        const outer = 0.96 * edgeRm, inner = Math.max(0.76 * edgeRm, outer - bandWidth);
        const A = P(r * outer, a0), B = P(r * outer, a1), C = P(r * inner, a1), D = P(r * inner, a0);
        addQuad(out, A, B, C, D, BAND, SURFACES.rubber);   // single face (wheel drawn cull-off → shows both sides, no z-fight)
      }
    }
    // Raised sidewall lettering ring(s): proud dark annulus inboard of the band (0.006 out
    // vs the band's 0.004, so the two faces never share a plane). A tyre option with no
    // lettering still gets one ring when sidewallInk is set, so the ink always shows.
    const sidewall = Math.max(0, Math.min(2, Math.round((tyreStyle && tyreStyle.sidewall) || 0))) || (inkColor ? 1 : 0);
    if (sidewall > 0) {
      const SW = inkColor || [0.16, 0.16, 0.17];
      const rings = sidewall === 2 ? [[0.700, 0.740], [0.775, 0.805]] as const : [[0.700, 0.740]] as const;
      for (const bs of [[x0, -1], [x1, 1]] as const) {
        const xb = bs[0] + bs[1] * 0.006;
        for (const ring of rings) for (let i = 0; i < SEG; i++) {
          const a0 = (i / SEG) * Math.PI * 2, a1 = ((i + 1) / SEG) * Math.PI * 2;
          const P = (rad: number, a: number): Vec3 => [xb, cy + rad * Math.cos(a), cz + rad * Math.sin(a)];
          addQuad(out, P(r * ring[1], a0), P(r * ring[1], a1),
                       P(r * ring[0], a1), P(r * ring[0], a0), SW, SURFACES.rubber);
        }
      }
    }

    // Cover vanes dress a covered face only; coverVanes alone never opts the three-ring
    // COVER back in — useCover does.
    const VANE: Vec3 = [0.26, 0.26, 0.30];
    const coverVanes = useCover
      ? (tyreStyle && tyreStyle.coverVanes != null ? tyreStyle.coverVanes : 6)
      : 0;
    for (const ss of [[x0, -1], [x1, 1]] as const) {
      const xs = ss[0] + ss[1] * 0.014;
      for (let k = 0; k < coverVanes; k++) {
        const a = (k / coverVanes) * Math.PI * 2 + 0.25;
        const uy = Math.cos(a), uz = Math.sin(a), py = -Math.sin(a), pz = Math.cos(a);
        const hw = 0.010, ri = rimR * 0.46, ro = rimR * 0.98;
        const P = (rad: number, s: number): Vec3 => [xs, cy + uy * rad + py * hw * s, cz + uz * rad + pz * hw * s];
        addQuad(out, P(ri, 1), P(ro, 1), P(ro, -1), P(ri, -1), VANE, SURFACES.metal);
      }
      const discFace = Math.max(0, Math.min(2, Math.round((brakeStyle && brakeStyle.discFace) || 0)));
      if (discFace > 0) {
        const marks = discFace === 1 ? 10 : 6;
        for (let k = 0; k < marks; k++) {
          const a = (k / marks) * Math.PI * 2 + 0.14;
          const rad = rimR * 0.74;
          const my = cy + rad * Math.cos(a), mz2 = cz + rad * Math.sin(a);
          const sz = discFace === 1 ? 0.016 : 0.030;
          addBox(out, xs, my, mz2, 0.004, sz, sz * (discFace === 1 ? 1 : 0.45),
                 [0.05, 0.05, 0.06], SURFACES.carbon);
        }
      }
    }
    const HUBCAP = RC;                   // raised boss: lighter than the dish floor
    const NUT = caliperColor || bandColor || [0.85, 0.72, 0.10];
    // Open hub is smaller so the rotor shows through the spoke gaps; cover keeps the wide
    // boss that sat on the old dish floor.
    const hubFrac = useCover ? 0.46 : 0.22;
    for (const ss of [[x0, -1], [x1, 1]] as const) {
      const dir = ss[1], xc0 = ss[0] - dir * 0.014, hcR = rimR * hubFrac, ctr: Vec3 = [xc0, cy, cz];
      for (let i = 0; i < SEG; i++) {
        const a0 = (i / SEG) * Math.PI * 2, a1 = ((i + 1) / SEG) * Math.PI * 2;
        addTri(out, ctr, [xc0, cy + hcR*Math.cos(a0), cz + hcR*Math.sin(a0)],
                         [xc0, cy + hcR*Math.cos(a1), cz + hcR*Math.sin(a1)], HUBCAP, SURFACES.metal);   // single face (cull-off → opaque both sides)
      }
      // Tyre recipes may own open-rim identity (spokes / dish / nut / gunNut) when the
      // wheel part leaves them unset. Wheel wins when it sets a value.
      const nutCol = (wheelStyle && wheelStyle.nut) || (tyreStyle && tyreStyle.nut) || NUT;
      const gunNut = (wheelStyle && wheelStyle.gunNut) || (tyreStyle && tyreStyle.gunNut) ? 1 : 0;
      if (!gunNut) {
        addBox(out, ss[0] - dir * 0.002, cy, cz, 0.026, Math.max(hcR * 0.55, rimR * 0.12), Math.max(hcR * 0.55, rimR * 0.12), nutCol, SURFACES.metal);
      } else {
        const nx = ss[0] - dir * 0.001;
        const nR = Math.max(hcR * 0.55, rimR * 0.10);
        const nDeep = 0.018;
        const HEX = 6;
        for (let h = 0; h < HEX; h++) {
          const a0 = (h / HEX) * Math.PI * 2 + Math.PI / HEX;
          const a1 = ((h + 1) / HEX) * Math.PI * 2 + Math.PI / HEX;
          const y0 = cy + nR * Math.cos(a0), z0 = cz + nR * Math.sin(a0);
          const y1 = cy + nR * Math.cos(a1), z1 = cz + nR * Math.sin(a1);
          const xOut = nx + dir * nDeep * 0.5, xIn = nx - dir * nDeep * 0.5;
          addQuad(out,
            [xOut, y0, z0], [xOut, y1, z1], [xIn, y1, z1], [xIn, y0, z0],
            nutCol, SURFACES.metal);
          addTri(out, [xOut, cy, cz], [xOut, y0, z0], [xOut, y1, z1], nutCol, SURFACES.metal);
        }
        const cR0 = nR * 1.15, cR1 = nR * 1.55, cxCol = nx - dir * nDeep * 0.55;
        for (let h = 0; h < 12; h++) {
          const a0 = (h / 12) * Math.PI * 2, a1 = ((h + 1) / 12) * Math.PI * 2;
          const P = (rad: number, a: number): Vec3 => [cxCol, cy + rad * Math.cos(a), cz + rad * Math.sin(a)];
          addQuad(out, P(cR0, a0), P(cR0, a1), P(cR1, a1), P(cR1, a0),
                  [nutCol[0] * 0.75, nutCol[1] * 0.75, nutCol[2] * 0.75], SURFACES.metal);
        }
      }
      // Rim SPOKES: extruded blades (front + back + long edges) from hub to rim. Open
      // default fills spokes:0 with OPEN_SPOKES so factory cars are not bare hoops; cover
      // path keeps recipe spokes. Tyre spokes fill in only when the wheel recipe leaves 0.
      const spokeWheel = Math.round((wheelStyle && wheelStyle.spokes) || 0);
      const spokeTyre = Math.round((tyreStyle && tyreStyle.spokes) || 0);
      const spokeReq = Math.max(0, Math.min(8, spokeWheel || spokeTyre));
      const spokeN = useCover ? spokeReq : (spokeReq > 0 ? spokeReq : OPEN_SPOKES);
      for (let k = 0; k < spokeN; k++) {
        const a = (k / spokeN) * Math.PI * 2 + 0.4;
        const uy = Math.cos(a), uz = Math.sin(a), py = -Math.sin(a), pz = Math.cos(a);
        const hw = 0.014, thick = 0.008;
        const ri = hcR * 1.08, ro = rimR * 0.90;
        const xsF = ss[0] + dir * 0.026, xsB = ss[0] + dir * 0.026 - dir * thick;
        const P = (xs: number, rad: number, sgn: number): Vec3 => [xs, cy + uy * rad + py * hw * sgn, cz + uz * rad + pz * hw * sgn];
        addQuad(out, P(xsF, ri, 1), P(xsF, ro, 1), P(xsF, ro, -1), P(xsF, ri, -1), HUBCAP, SURFACES.metal);
        addQuad(out, P(xsB, ri, -1), P(xsB, ro, -1), P(xsB, ro, 1), P(xsB, ri, 1), HUBCAP, SURFACES.metal);
        addQuad(out, P(xsF, ri, 1), P(xsF, ro, 1), P(xsB, ro, 1), P(xsB, ri, 1), HUBCAP, SURFACES.metal);
        addQuad(out, P(xsF, ri, -1), P(xsB, ri, -1), P(xsB, ro, -1), P(xsF, ro, -1), HUBCAP, SURFACES.metal);
      }
      // Rim TAPE: face band + short OD bead so the set marks read from a ¾ view.
      if (wheelStyle && wheelStyle.tape) {
        // f1-game passes `tc` straight to addQuad; with neither nut nor band set it is
        // undefined there too (and addTri would throw on it), so the `!` keeps that.
        const tr = rimR * 1.02, tc = ((wheelStyle.nut) || bandColor)!;
        for (let k = 0; k < 20; k++) {
          const a0 = (k / 20) * Math.PI * 2, a1 = ((k + 1) / 20) * Math.PI * 2;
          const A = (rad: number, a: number): Vec3 => [ss[0] + dir * 0.010, cy + rad * Math.cos(a), cz + rad * Math.sin(a)];
          addQuad(out, A(tr, a0), A(tr + 0.022, a0), A(tr + 0.022, a1), A(tr, a1), tc, SURFACES.metal);
        }
        const beadR = rimR * 1.01;
        const bx0 = ss[0] + dir * 0.002, bx1 = ss[0] + dir * 0.016;
        for (let k = 0; k < 16; k++) {
          const a0 = (k / 16) * Math.PI * 2, a1 = ((k + 1) / 16) * Math.PI * 2;
          const y0 = cy + beadR * Math.cos(a0), z0 = cz + beadR * Math.sin(a0);
          const y1 = cy + beadR * Math.cos(a1), z1 = cz + beadR * Math.sin(a1);
          addQuad(out, [bx0, y0, z0], [bx1, y0, z0], [bx1, y1, z1], [bx0, y1, z1], tc, SURFACES.metal);
        }
      }
      const dishWheel = Math.round((wheelStyle && wheelStyle.dish) || 0);
      const dishTyre = Math.round((tyreStyle && tyreStyle.dish) || 0);
      const dish = Math.max(0, Math.min(2, dishWheel || dishTyre));
      if (dish > 0) {
        const dr = rimR * (dish === 2 ? 0.80 : 0.88);
        const dxOut = ss[0] + dir * 0.014;
        // Cover path keeps the old shallow bowl (cover already fills the face). Open path:
        // deeper rim recess only — NO floor fan to the hub, so factory dish:1 cars stay
        // open-spoked with the brake disc visible. 0.024*dish → 24 / 48 mm for WEAK_MM.
        const dishStep = useCover ? 0.012 * dish : 0.024 * dish;
        const dxIn = ss[0] + dir * (0.014 - dishStep);
        const DISH_SEG = 16;
        for (let k = 0; k < DISH_SEG; k++) {
          const a0 = (k / DISH_SEG) * Math.PI * 2, a1 = ((k + 1) / DISH_SEG) * Math.PI * 2;
          const oy0 = cy + rimR * 0.98 * Math.cos(a0), oz0 = cz + rimR * 0.98 * Math.sin(a0);
          const oy1 = cy + rimR * 0.98 * Math.cos(a1), oz1 = cz + rimR * 0.98 * Math.sin(a1);
          const iy0 = cy + dr * Math.cos(a0), iz0 = cz + dr * Math.sin(a0);
          const iy1 = cy + dr * Math.cos(a1), iz1 = cz + dr * Math.sin(a1);
          if (useCover) {
            addQuad(out,
              [dxOut, oy0, oz0], [dxOut, oy1, oz1], [dxOut, iy1, iz1], [dxOut, iy0, iz0],
              HUBCAP, SURFACES.metal);
            addQuad(out,
              [dxOut, iy0, iz0], [dxOut, iy1, iz1], [dxIn, iy1, iz1], [dxIn, iy0, iz0],
              RC_DEEP, SURFACES.metal);
            addTri(out, [dxIn, cy, cz],
                   [dxIn, iy0, iz0],
                   [dxIn, iy1, iz1], HUBCAP, SURFACES.metal);
          } else {
            // Open: narrow rim lip + recess wall only (inner radius stays near the lip).
            const lipInner = rimR * (dish === 2 ? 0.86 : 0.90);
            const ly0 = cy + lipInner * Math.cos(a0), lz0 = cz + lipInner * Math.sin(a0);
            const ly1 = cy + lipInner * Math.cos(a1), lz1 = cz + lipInner * Math.sin(a1);
            addQuad(out,
              [dxOut, oy0, oz0], [dxOut, oy1, oz1], [dxOut, ly1, lz1], [dxOut, ly0, lz0],
              HUBCAP, SURFACES.metal);
            addQuad(out,
              [dxOut, ly0, lz0], [dxOut, ly1, lz1], [dxIn, ly1, lz1], [dxIn, ly0, lz0],
              RC_DEEP, SURFACES.metal);
          }
        }
      }
    }
    const calOut = fixedOut || out;
    const cr = r * 0.78;
    const calA = brakeStyle && brakeStyle.caliperPos || 0;
    // Inboard leading-edge duct scoop — visible through the cover peek.
    const ductMul = brakeStyle && brakeStyle.duct != null ? brakeStyle.duct : 1;
    addBox(calOut, cx, cy + 0.035, cz + r * 0.38,
           w * 0.42, 0.048 * Math.max(0.65, ductMul), 0.062 * Math.max(0.65, ductMul),
           INTAKE, SURFACES.carbon);
    if (caliperColor) {
      const padCol: Vec3 = [caliperColor[0]*0.30, caliperColor[1]*0.30, caliperColor[2]*0.30];
      const calLvl = Math.max(0, Math.min(2, Math.round((brakeStyle && brakeStyle.caliper) || 0)));
      if (calLvl === 0) {
        for (let i = 0; i < 3; i++) {
          const a = calA + (i - 1) * 0.17;       // ~±10° arc around selected clock position
          addBox(calOut, cx, cy + Math.cos(a) * cr, cz + Math.sin(a) * cr,
                 w * 1.06, 0.052, 0.055, caliperColor, SURFACES.metal);
        }
        for (const sgn of [-1, 1])
          addBox(calOut, cx + sgn * (w * 0.52 + 0.006), cy + cr, cz, 0.02, 0.05, 0.11, padCol, SURFACES.metal);
        addBox(calOut, cx, cy + cr + 0.04, cz, w * 1.0, 0.02, 0.10, caliperColor, SURFACES.metal);
      } else {
        const cY = cy + Math.cos(calA) * cr, cZ = cz + Math.sin(calA) * cr;
        const pistons = calLvl === 2 ? 6 : 4;
        const bodyW = w * (calLvl === 2 ? 1.14 : 1.08);
        const bodyH = calLvl === 2 ? 0.078 : 0.068;
        const bodyD = calLvl === 2 ? 0.118 : 0.100;
        addBox(calOut, cx, cY, cZ, bodyW, bodyH, bodyD, caliperColor, SURFACES.metal);
        addBox(calOut, cx, cY, cZ, bodyW * 0.42, bodyH * 0.45, bodyD * 0.55,
               [0.04, 0.04, 0.05], SURFACES.metal);
        const ty = -Math.sin(calA), tz = Math.cos(calA);
        const span = bodyD * 0.62;
        for (const sgn of [-1, 1]) {
          for (let p = 0; p < pistons; p++) {
            const t = (p / (pistons - 1) - 0.5) * span;
            addBox(calOut, cx + sgn * (w * 0.50 + 0.012), cY + ty * t, cZ + tz * t,
                   0.018, 0.028, 0.028, padCol, SURFACES.metal);
          }
        }
        for (const sgn of [-1, 1])
          addBox(calOut, cx + sgn * (w * 0.52 + 0.006), cY, cZ, 0.016, 0.042, 0.090, padCol, SURFACES.metal);
        const earR = cr - 0.055;
        addBox(calOut, cx, cy + Math.cos(calA) * earR, cz + Math.sin(calA) * earR,
               w * 0.55, 0.024, 0.040, caliperColor, SURFACES.metal);
        addBox(calOut, cx, cY + 0.048, cZ, 0.014, 0.016, 0.016, [0.55, 0.55, 0.58], SURFACES.metal);
      }
    } else {
      const peek: Vec3 = [0.28, 0.18, 0.12];
      addBox(calOut, cx, cy + Math.cos(calA) * cr, cz + Math.sin(calA) * cr,
             w * 0.88, 0.040, 0.050, peek, SURFACES.metal);
    }
  }

  // car-wheels.js:497
  function buildWheel(w: number | null | undefined, bandColor: Col, caliperColor: Col, rimColor: Col, grooved: unknown,
                      tyreStyle: Style<TyreStyle>, brakeStyle: Style<BrakeStyle>, wheelStyle: Style<WheelStyle>, inkColor?: Col): MeshOut {
    const out: MeshOut = { pos: [], nrm: [], col: [], mat: [], idx: [] };
    addWheel(out, 0, 0, 0, 0.34, w || 0.34, bandColor, caliperColor, rimColor,
      grooved, tyreStyle, null, brakeStyle, wheelStyle, inkColor);
    return out;
  }
  // car-wheels.js:503
  function buildWheelLayers(w: number | null | undefined, bandColor: Col, caliperColor: Col, rimColor: Col, grooved: unknown,
                            tyreStyle: Style<TyreStyle>, brakeStyle: Style<BrakeStyle>, wheelStyle: Style<WheelStyle>,
                            inkColor?: Col): { rotating: MeshOut; fixed: MeshOut } {
    const rotating: MeshOut = { pos: [], nrm: [], col: [], mat: [], idx: [] };
    const fixed: MeshOut = { pos: [], nrm: [], col: [], mat: [], idx: [] };
    const width = w || 0.34;
    addWheel(rotating, 0, 0, 0, 0.34, width, bandColor, caliperColor, rimColor,
      grooved, tyreStyle, fixed, brakeStyle, wheelStyle, inkColor);
    // The hub carrier the wishbones and caliper terminate in (was a cube inside the rim,
    // visible through the spokes from every angle).
    const front: Station = { z: 0.06, x: 0, y: 0, w: width * 0.72, h: 0.125, t: 0.60 };
    const rear: Station = { z: -0.06, x: 0, y: 0, w: width * 0.66, h: 0.110, t: 0.70 };
    addSpan(fixed, front, rear, [0.18, 0.18, 0.20], null, SURFACES.metal);
    return { rotating, fixed };
  }

  return { addWheel, buildWheel, buildWheelLayers };
}

export type CarWheelsApi = ReturnType<typeof create>;
export const CarWheels = Object.freeze({ create, tints });
