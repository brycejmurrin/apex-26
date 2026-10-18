// Livery decals for three.js: the LiveryTex atlas as a CanvasTexture, and the decal
// quads that map its regions onto the car body.
//
// carDecalData is ported verbatim from f1-game js/car/car-mesh.js:34-326 (with its
// decalRound helper, car-mesh.js:19). It emits f1-game's {pos,nrm,uv,idx} record in
// f1-game car space. Only carDecalData came over: the rest of car-mesh.js (decal
// mesh cache, cockpit decal, wheels, flaps, the cockpit rig) is out of scope here.
// Deviation: car-mesh guards every Car3D member (`Car3D.coverProfile ? … : literal`)
// for a stale car3d.js bundle; Car3D is an import here and has them all, so the
// literal fallbacks are dropped and the always-taken branch kept.
//
// The texture follows f1-game's glx.js createTexture (glx.js:1345-1365): FLIP_Y
// (three's default flipY, which carDecalData's `v = 1 - y / SIZE_H` assumes),
// premultiplied alpha and a trilinear mip chain; the material follows drawDecal
// (glx.js:1515-1560): alpha-blended ONE / ONE_MINUS_SRC_ALPHA, depth test on,
// depth write off, both faces.
//
// HANDEDNESS. Same rule as ./three.ts meshToGeometry: f1-game car space is
// left-handed (+X = driver's right), so decalGeometry mirrors X (x -> -x, normal
// x -> -x) and reverses the winding. carDecalData pre-flips U for f1-game's
// det -1 model matrix (car-mesh.js:51-54); that mirror is exactly this one, so
// text reads the right way round on both flanks.
import {
  BufferAttribute, BufferGeometry, CanvasTexture, DoubleSide, LinearFilter, LinearMipmapLinearFilter, Mesh,
  MeshStandardNodeMaterial, SRGBColorSpace,
} from "three/webgpu";
import { Car3D, type PartTiers } from "./car3d";
import * as CarShade from "./shade";
import { LiveryTex, buildAtlas, type TeamId, type TexLivery } from "./liverytex";
import type { LiveryCanvas, LiveryRect } from "./livery-canvas";
import type { CoverProfile, CoverStation } from "./body-geom";

/** f1-game's textured-mesh record (gfx.createTexMesh input). */
export interface DecalData {
  pos: number[];
  nrm: number[];
  uv: number[];
  idx: number[];
}

type P3 = readonly [number, number, number];
type UV = readonly [number, number];

// Is this decal sheet for the ROUNDED car? The same switch Car3D.build reads
// (CarShade.on(teamId)); an imported body never is.
const decalRound = (legacyBody: boolean | null | undefined, teamId: TeamId) => !legacyBody && CarShade.on(teamId);

/** car-mesh.js:34 — the decal quads for one car (aero level, parts, team, fin, spine). */
export function carDecalData(aLvl: number, parts: PartTiers | null | undefined, legacyBody: boolean | null | undefined, teamId: TeamId,
  finShape?: string | null, spineHeight?: string | null): DecalData {
  const R = LiveryTex.REGIONS, S = LiveryTex.SIZE, SH = LiveryTex.SIZE_H || S;
  const out: DecalData = { pos: [], nrm: [], uv: [], idx: [] };
  // Imported GLBs are static and do not consume the procedural parts recipe.
  // Resolve their overlays against the default body once, regardless of setup.
  // teamId threads the per-team chassis style into the anchors so decals stay
  // glued to a styled (longer/slimmer/drooped) nose and inlet.
  const anchorParts = legacyBody ? null : parts;
  // spineHeight lifts the engine-cover crown the spine crest sits on (cf/cr
  // below read coverAt().top), so the decal takes the same anchors as the mesh.
  // `round`: the rounded car (CarShade on for this team, as Car3D.build decides
  // it) carries the coke-bottle cover and the downwash ramp in its anchors.
  const round = decalRound(legacyBody, teamId);
  const anchors = Car3D.bodyAnchors(anchorParts, legacyBody ? null : teamId, spineHeight, round);
  // Map a canvas-pixel region → UV rect (v flipped: createTexture uploads FLIP_Y).
  const uvOf = (r: LiveryRect) => ({ uL: r.x / S, uR: (r.x + r.w) / S, vT: 1 - r.y / SH, vB: 1 - (r.y + r.h) / SH });
  // corners in [BL, BR, TR, TL] order (upright as seen from outside) → the region.
  // NOTE: the in-race car model matrix is a REFLECTION (det −1: tmpU = tmpR×tmpF,
  // so [r,u,f] is left-handed — the symmetric body hides it, asymmetric decal text
  // does not). U is pre-flipped here (uR↔uL) so the reflection un-mirrors the text
  // back to readable. The setup-preview car is drawn with a matching x-reflection.
  const quad = (c: readonly P3[], n: P3, region: LiveryRect) => {
    const u = uvOf(region), i = out.pos.length / 3;
    const uvs: UV[] = [[u.uR, u.vB], [u.uL, u.vB], [u.uL, u.vT], [u.uR, u.vT]];
    for (let k = 0; k < 4; k++) { out.pos.push(c[k]![0], c[k]![1], c[k]![2]); out.nrm.push(n[0], n[1], n[2]); out.uv.push(uvs[k]![0], uvs[k]![1]); }
    out.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  };
  const quadUv = (c: readonly P3[], n: P3, uvs: readonly UV[]) => {
    const i = out.pos.length / 3;
    for (let k = 0; k < 4; k++) {
      out.pos.push(c[k]![0], c[k]![1], c[k]![2]);
      out.nrm.push(n[0], n[1], n[2]);
      out.uv.push(uvs[k]![0], uvs[k]![1]);
    }
    out.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  };
  const quadN = (c: readonly P3[], ns: readonly P3[], uvs: readonly UV[]) => {   // quadUv with a normal per corner: a strip that bends shades as one
    const i = out.pos.length / 3;
    for (let k = 0; k < 4; k++) {
      out.pos.push(c[k]![0], c[k]![1], c[k]![2]);
      out.nrm.push(ns[k]![0], ns[k]![1], ns[k]![2]);
      out.uv.push(uvs[k]![0], uvs[k]![1]);
    }
    out.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  };
  const zF = 0.46, zR = -0.34;
  const pY = (p: { bottom: number; top: number }, f: number) => p.bottom + (p.top - p.bottom) * f;
  const podAt = (z: number) => anchors.podAt(z);
  const podStops = (front: number, rear: number) => {
    const internal = anchors.podStations.map((p) => p.z);
    return [front, ...internal.filter((z) => z < front && z > rear), rear]
      .sort((a, b) => b - a);
  };
  const podDecal = (region: LiveryRect, yBottom: number, yTop: number, proud: number) => {
    const u = uvOf(region), stops = podStops(zF, zR);
    for (let i = 0; i < stops.length - 1; i++) {
      const aZ = stops[i]!, bZ = stops[i + 1]!, a = podAt(aZ), b = podAt(bZ);
      const ta = (zF - aZ) / (zF - zR), tb = (zF - bZ) / (zF - zR);
      const rU = (t: number) => u.uR + (u.uL - u.uR) * t;
      const lU = (t: number) => u.uL + (u.uR - u.uL) * t;
      quadUv([[a.x+proud, pY(a,yBottom), aZ], [b.x+proud, pY(b,yBottom), bZ],
              [b.x+proud, pY(b,yTop), bZ], [a.x+proud, pY(a,yTop), aZ]], [1, 0, 0],
             [[rU(ta),u.vB], [rU(tb),u.vB], [rU(tb),u.vT], [rU(ta),u.vT]]);
      quadUv([[-b.x-proud, pY(b,yBottom), bZ], [-a.x-proud, pY(a,yBottom), aZ],
              [-a.x-proud, pY(a,yTop), aZ], [-b.x-proud, pY(b,yTop), bZ]], [-1, 0, 0],
             [[lU(tb),u.vB], [lU(ta),u.vB], [lU(ta),u.vT], [lU(tb),u.vT]]);
    }
  };
  podDecal(R.titleA, 0.32, 0.80, 0.018);   // sits wholly on the PANEL board
  const cf = anchors.coverAt(-0.62);
  const cr = anchors.coverAt(-1.28);
  {
    // The crown is ROUNDED (Car3D.coverProfile: a flat centre ±0.32x, two facets
    // down to the shoulder at ±0.72x), so the crest is a strip of five quads
    // draped over it, shoulder to shoulder — the same ±0.72x span the flat quad
    // covered, so the mark keeps its size; only its edges now bend down with
    // the skin instead of floating over it. u is by chord (x), which keeps the
    // centre of the mark undistorted, and is pre-flipped exactly as quad() does.
    const pf = Car3D.coverProfile(cf), pr = Car3D.coverProfile(cr);
    const across = (p: CoverProfile): [number, number][] => {   // left → right: -shoulder, -facet, -crown, crown, facet, shoulder
      const r = p.pts.slice(1);   // shoulder, facet, crown (right side, outer → inner)
      return r.map(([x, y]): [number, number] => [-x, y]).concat(r.slice().reverse() as [number, number][]);
    };
    // Car3D.COVER_STACK.decal, not a literal: the crown carries the heat shield
    // and the spine vent under this wrap, and at a literal 0.008 the shield's
    // top face (top+0.017) swallows 300 mm of the tail strip while the vent's
    // ties the plane exactly. car3d owns the order; this reads it.
    const PROUD = Car3D.COVER_STACK.decal || 0.022;
    // Drape one region over the crown between two stations, shoulder to shoulder.
    const drape = (region: LiveryRect, zF: number, zR: number, pF: CoverProfile, pR: CoverProfile) => {
      const uv = uvOf(region), L = across(pF), Rr = across(pR), W = pF.pts[1]![0] * 2;
      for (let i = 0; i < L.length - 1; i++) {
        const [xa, ya] = L[i]!, [xb, yb] = L[i + 1]!, [xc, yc] = Rr[i]!, [xd, yd] = Rr[i + 1]!;
        // outward normal of this facet (right-handed: +x when the surface drops to the right)
        const dx = xb - xa, dy = yb - ya, nl = Math.hypot(dx, dy) || 1, nx = -dy / nl, ny = dx / nl;
        const fa = (xa + W / 2) / W, fb = (xb + W / 2) / W;
        const uu = (f: number) => uv.uR + (uv.uL - uv.uR) * f;
        quadUv([[xa + nx * PROUD, ya + ny * PROUD, zF], [xb + nx * PROUD, yb + ny * PROUD, zF],
                [xd + nx * PROUD, yd + ny * PROUD, zR], [xc + nx * PROUD, yc + ny * PROUD, zR]],
               [nx, ny, 0.06], [[uu(fa), uv.vB], [uu(fb), uv.vB], [uu(fb), uv.vT], [uu(fa), uv.vT]]);
      }
    };
    drape(R.crest, -0.62, -1.28, pf, pr);
    // The TAIL strip: the same drape over the cover behind the crest, so the
    // SPINE TOP band designs run on to the wing (REGIONS.tail; bare unless a
    // band design is picked).
    if (R.tail) {
      // Starts on the crest strip's rear edge (-1.28): a shared edge, so a
      // saddle or a stripe runs seamlessly from crown to tail.
      const tf = anchors.coverAt(-1.28);
      const tr = anchors.coverAt(-1.92);
      drape(R.tail, -1.28, -1.92, Car3D.coverProfile(tf), Car3D.coverProfile(tr));
    }
  }
  // SPINE SIDE: the WHOLE engine-cover flank, both sides — from just behind
  // the airbox (z -0.66) to the wing (-1.90), and from under the shoulder
  // crease (v 0.96) down to the sidepod line (v 0.06). At each station the
  // flank is the straight line from (x, bottom) up to the SHOULDER
  // (Car3D.coverProfile: 0.72x, top - d; the rounded crown sits above it).
  // The whole side is one canvas so a design can run the length of the cover
  // (the RB22's Red Bull, the W17's bars, the SF-26's white) — the price is
  // that a canvas pixel is ~1.4× longer along the car than down the flank
  // (1.24 m over 304 px vs ~0.47 m over 160 px); LiveryTex.FLANK_SQUASH
  // compensates for the marks. Corners follow the endplate-number order below
  // so the text reads on both sides under the reflected model matrix. Always
  // mapped: an unpicked spineSide is an unpainted region, like the fin panel.
  if (R.spineSide) {
    // Car3D.COVER_STACK.flankDecal — the pinstripe and the service hatches are
    // bodywork UNDER this wrap, and at a literal 0.010 the pinstripe is
    // coplanar with it (0.9 mm) and the hatches stand 9 mm proud of it.
    const sZ: readonly [number, number] = [-0.66, -1.90], V_TOP = 0.96, V_BOT = 0.06;
    const PROUD = Car3D.COVER_STACK.flankDecal || 0.014;
    // The rounded car's flank runs from its pinched FOOT (coverProfile pts[0],
    // the coke-bottle xb) to the shoulder (pts[1]); the flat car's is 0.28x lean.
    const foot = (p: CoverProfile) => (round && p.pts ? p.pts[0]![0] : p.x);
    const flank = (z: number) => {
      const c: CoverStation = anchors.coverAt(z);
      const p = Car3D.coverProfile(c);
      const lean = round && p.pts ? p.pts[0]![0] - p.pts[1]![0] : 0.28 * p.x;
      const h = p.shoulder - p.bottom, nl = Math.hypot(h, lean), nx = h / nl, ny = lean / nl;
      const at = (v: number): [number, number] => [(round && p.pts ? foot(p) - lean * v : p.x * (1 - 0.28 * v)) + nx * PROUD, p.bottom + h * v + ny * PROUD];
      return { b: at(V_BOT), t: at(V_TOP), nx, ny };
    };
    if (round && CarShade.COVER_Z) {
      // ROUNDED: the coke pinch curves the foot between stations, and one
      // straight quad edge from -0.66 to -1.90 is a chord across that curve:
      // measured, up to 40 mm off the skin at the waist (coke 1.38) against
      // 14 mm at its ends, so the band floats free. So the band is a strip of
      // sub-quads at the rings the cover is lofted at (CarShade.COVER_Z), u by
      // z and a normal per corner, which keeps it its PROUD off the skin.
      const zs = ([sZ[0]] as number[]).concat(CarShade.COVER_Z.filter((z) => z < sZ[0] && z > sZ[1]), [sZ[1]]);
      const F = zs.map(flank), f = (z: number) => (sZ[0] - z) / (sZ[0] - sZ[1]);   // 0 at the front, 1 at the rear
      const uR = uvOf(R.spineSide), uL = uvOf(R.spineSideL || R.spineSide);
      const uRight = (z: number) => uR.uR + (uR.uL - uR.uR) * f(z), uLeft = (z: number) => uL.uL + (uL.uR - uL.uL) * f(z);
      for (let i = 0; i < zs.length - 1; i++) {
        const a = F[i]!, b = F[i + 1]!, za = zs[i]!, zb = zs[i + 1]!;
        // Same corner order and u pre-flip as the flat quads below: +x front at uR, -x front at uL.
        quadN([[a.b[0], a.b[1], za], [b.b[0], b.b[1], zb], [b.t[0], b.t[1], zb], [a.t[0], a.t[1], za]],
              [[a.nx, a.ny, 0], [b.nx, b.ny, 0], [b.nx, b.ny, 0], [a.nx, a.ny, 0]],
              [[uRight(za), uR.vB], [uRight(zb), uR.vB], [uRight(zb), uR.vT], [uRight(za), uR.vT]]);
        quadN([[-b.b[0], b.b[1], zb], [-a.b[0], a.b[1], za], [-a.t[0], a.t[1], za], [-b.t[0], b.t[1], zb]],
              [[-b.nx, b.ny, 0], [-a.nx, a.ny, 0], [-a.nx, a.ny, 0], [-b.nx, b.ny, 0]],
              [[uLeft(zb), uL.vB], [uLeft(za), uL.vB], [uLeft(za), uL.vT], [uLeft(zb), uL.vT]]);
      }
    } else {
      const a = flank(sZ[0]), b = flank(sZ[1]);
      quad([[a.b[0], a.b[1], sZ[0]], [b.b[0], b.b[1], sZ[1]], [b.t[0], b.t[1], sZ[1]], [a.t[0], a.t[1], sZ[0]]],
           [a.nx, a.ny, 0], R.spineSide);
      // Under the det −1 model matrix the +x quad above renders as the car's
      // RIGHT flank (canvas-left at the rear) and this −x quad as its LEFT
      // (canvas-left at the front) — LiveryTex.FLANKS authors each in that
      // side's outside view. A stale atlas without this region mirrors the first.
      quad([[-b.b[0], b.b[1], sZ[1]], [-a.b[0], a.b[1], sZ[0]], [-a.t[0], a.t[1], sZ[0]], [-b.t[0], b.t[1], sZ[1]]],
           [-a.nx, a.ny, 0], R.spineSideL || R.spineSide);
    }
  }
  // The fin's blade height is a recipe knob, so the decal has to be placed on
  // the SAME outline the mesh used. sharkFinPanel/sharkFinBadge default to a
  // scale of 1 when this is absent, which is what every legacy caller gets.
  const finS = (parts && parts._visual && parts._visual.aero && parts._visual.aero.fin) || 1;
  // The livery's FIN SHAPE picks the outline the decal is stretched over — the
  // same FIN_SHAPES entry build() cut the blade from — and "none" is no blade,
  // so no panel and no badge either: a graphic hanging in the air behind the
  // airbox is exactly what this branch exists to prevent.
  const fShape = finShape || "standard";
  // The blade's ROOT, from the same Car3D function build() cuts it with: a
  // decal placed off the FROZEN base while the mesh roots itself into the
  // engine cover lets a raised crown (every shipped team ships spineHeight
  // "dorsal") swallow most of the panel and all of the badge.
  // A cover taller than the regulation fin top leaves no blade at all; painting
  // a graphic onto one is worse than leaving the region unmapped, so `clear`
  // gates it the same way finShape "none" does.
  const fRoot = Car3D.sharkFinRoot(anchors, finS, fShape);
  const finVisible = fShape !== "none" && (!fRoot || fRoot.clear > 0.03);
  if (finVisible) {
    const fp = Car3D.sharkFinPanel(null, null, finS, fShape, fRoot);
    const FIN_N = 0.78, FIN_NY = 0.62;      // normalised: 0.78² + 0.62² ≈ 1
    const face = (c: readonly { x: number; y: number; z: number }[], region: LiveryRect) => {
      const v = (i: number, s: number): P3 => [s * c[i]!.x, c[i]!.y, c[i]!.z];
      quad([v(0, 1), v(1, 1), v(2, 1), v(3, 1)], [FIN_N, FIN_NY, 0], region);
      quad([v(1, -1), v(0, -1), v(3, -1), v(2, -1)], [-FIN_N, FIN_NY, 0], region);
    };
    face(fp, R.fin);
    if (R.finBadge) face(Car3D.sharkFinBadge(null, finS, fShape, fRoot), R.finBadge);
  }
  const nR = anchors.noseAt(1.72);
  const nF = anchors.noseAt(2.10);
  quad([[-nF.topSide*0.84, nF.top+0.020, 2.10], [nF.topSide*0.84, nF.top+0.020, 2.10],
        [nR.topSide*0.84, nR.top+0.020, 1.72], [-nR.topSide*0.84, nR.top+0.020, 1.72]], [0, 1, 0.05], R.num);
  const nsR = anchors.noseAt(1.16);
  const nsF = anchors.noseAt(1.66);
  quad([[-nsF.topSide*0.82, nsF.top+0.014, 1.66], [nsF.topSide*0.82, nsF.top+0.014, 1.66],
        [nsR.topSide*0.82, nsR.top+0.014, 1.16], [-nsR.topSide*0.82, nsR.top+0.014, 1.16]], [0, 1, 0.10], R.titleB);
  // Sidepod lower flank → long sponsor strip.
  podDecal(R.strip, 0.08, 0.30, 0.020);   // sits wholly on the c2 accent band
  // Rear-wing endplate number boards → the driver number plus the team lockup
  // (classic F1 — identity reads on the nose AND the rear-wing endplates). The board height/pos
  // TRACKS the wing: Car3D.numberBoard(aLvl) is the SAME function the car mesh
  // uses to place the physical board, so the digit lands on it at every downforce
  // level (mesh is cached per aLvl — see getCarDecalMesh).
  // Rear-wing UPPER FLAP → the sponsor band. Car3D.wingBand is the SAME solver
  // that POSES the flap, not the recipe that designs it: the design chord is
  // 19.5 degrees off where drawAeroFlaps actually hangs the element, so a band
  // drawn from it floats ~90 mm over a parked car's wing. The
  // whole placement — rest attitude, skin, proud offset, surface normal — lives
  // in car3d beside the pose solve, for the reason frontPlate does.
  {
    const lvl = aLvl == null ? 2 : aLvl;
    const B = Car3D.wingBand(lvl, Car3D.aeroStyleOf(parts));
    if (B) {
      // One quad per spanwise segment, u by x — the same treatment podDecal and
      // the cover drape give a curved surface, and for the same reason: a single
      // quad across a swept wing bridges the sweep instead of following it.
      const u = uvOf(R.wing), S = B.stations;
      for (let i = 0; i < S.length - 1; i++) {
        const a = S[i]!, b = S[i + 1]!;
        const uu = (x: number) => u.uR + (u.uL - u.uR) * ((x + B.half) / (B.half * 2));
        quadUv([[a.x, a.front.y, a.front.z], [b.x, b.front.y, b.front.z],
                [b.x, b.rear.y, b.rear.z], [a.x, a.rear.y, a.rear.z]],
               a.nrm, [[uu(a.x), u.vB], [uu(b.x), u.vB], [uu(b.x), u.vT], [uu(a.x), u.vT]]);
      }
    }
  }
  // FRONT-WING ENDPLATE → a partner mark on the outer face of each plate.
  // Car3D.frontPlate is the SAME function that places the plate, because the
  // plate's height, its outboard kick, its thickness and even its taper all
  // move with the aero level and the `plate` pick: a decal drawn from literals
  // lands in clear air on three of the four profiles. The corners follow the
  // taper (the top of the plate is narrower than the bottom) and sit inside
  // the plate's edges, so the mark never overhangs into space.
  {
    const fp = Car3D.frontPlate(aLvl == null ? 2 : aLvl,
                               parts && parts._visual && parts._visual.aero);
    const at = (u: number) => ({
      z: fp.front.z + (fp.rear.z - fp.front.z) * u,
      x: fp.front.x + (fp.rear.x - fp.front.x) * u,
      y: fp.front.y + (fp.rear.y - fp.front.y) * u,
      h: fp.front.h + (fp.rear.h - fp.front.h) * u,
      t: fp.front.t + (fp.rear.t - fp.front.t) * u,
    });
    // u along the chord (0 = front station), f up the plate (0 = bottom). The
    // mark takes the middle band, not the whole plate: a real endplate carries
    // a partner logo with plate showing around it, and the plate is only
    // 0.16-0.30 m tall at its front station.
    const corner = (u: number, f: number) => {
      const st = at(u), frac = 0.30 + 0.44 * f;
      // st.x is the plate's CENTRELINE; the outer face is half a thickness
      // outboard of it, narrowing with the taper toward the top.
      return { x: st.x + (fp.w / 2) * (1 + (st.t - 1) * frac) + 0.004,
               y: st.y - st.h / 2 + st.h * frac, z: st.z };
    };
    const BL = corner(0.20, 0), BR = corner(0.80, 0), TR = corner(0.80, 1), TL = corner(0.20, 1);
    // Same corner order as the rear endplate boards above: from OUTSIDE, the
    // front of the car reads left, and the -x side takes the mirrored order.
    quad([[BL.x, BL.y, BL.z], [BR.x, BR.y, BR.z], [TR.x, TR.y, TR.z], [TL.x, TL.y, TL.z]], [1, 0, 0], R.fwEnd);
    quad([[-BR.x, BR.y, BR.z], [-BL.x, BL.y, BL.z], [-TL.x, TL.y, TL.z], [-TR.x, TR.y, TR.z]], [-1, 0, 0], R.fwEnd);
  }
  const nb = Car3D.numberBoard(aLvl == null ? 2 : aLvl);
  const ex = 0.539, eyB = nb.cy - nb.h * 0.5 + 0.01, eyT = nb.cy + nb.h * 0.5 - 0.01, ezF = -2.30, ezR = -2.52;
  quad([[ex, eyB, ezF], [ex, eyB, ezR], [ex, eyT, ezR], [ex, eyT, ezF]], [1, 0, 0], R.num);
  quad([[-ex, eyB, ezR], [-ex, eyB, ezF], [-ex, eyT, ezF], [-ex, eyT, ezR]], [-1, 0, 0], R.num);
  return out;
}

// ---------------------------------------------------------------------------
// three.js bridge.

/** Wrap an atlas canvas (LiveryTex.buildAtlas) as an sRGB, premultiplied, mipmapped CanvasTexture. */
export function createLiveryTexture(canvas: LiveryCanvas): CanvasTexture {
  const tex = new CanvasTexture(canvas as unknown as HTMLCanvasElement);
  tex.name = "livery-atlas";
  tex.colorSpace = SRGBColorSpace;
  tex.flipY = true;                 // glx.js createTexture: UNPACK_FLIP_Y_WEBGL
  tex.premultiplyAlpha = true;      // ...and UNPACK_PREMULTIPLY_ALPHA_WEBGL
  tex.generateMipmaps = true;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Paint a team's atlas (LiveryTex.buildAtlas) straight into a texture. */
export function buildLiveryTexture(teamId: TeamId, colors?: TexLivery | null, numberOverride?: number | string | null,
  isPlayer?: boolean, hiRes?: boolean): CanvasTexture {
  return createLiveryTexture(buildAtlas(teamId, colors ?? {}, numberOverride, isPlayer, hiRes));
}

export interface DecalGeometryOptions {
  /** Mirror f1-game's left-handed car space into three's right-handed one (default true; ./three.ts does the same). */
  mirrorX?: boolean;
}

/** carDecalData record -> indexed BufferGeometry (position, normal, uv). */
export function decalGeometry(d: DecalData, opts: DecalGeometryOptions = {}): BufferGeometry {
  const mirror = opts.mirrorX ?? true;
  const n = d.pos.length / 3;
  const pos = new Float32Array(d.pos);
  const nrm = new Float32Array(d.nrm);
  if (mirror) for (let i = 0; i < n * 3; i += 3) { pos[i] = -pos[i]!; nrm[i] = -nrm[i]!; }
  const idx = n > 65535 ? new Uint32Array(d.idx) : new Uint16Array(d.idx);
  if (mirror) for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]!; idx[i + 1] = idx[i + 2]!; idx[i + 2] = t; }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("normal", new BufferAttribute(nrm, 3));
  g.setAttribute("uv", new BufferAttribute(new Float32Array(d.uv), 2));
  g.setIndex(new BufferAttribute(idx, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** The decal material: the atlas, premultiplied alpha blend, depth test without depth write, both faces (glx.js drawDecal). */
export function createDecalMaterial(texture: CanvasTexture): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({
    map: texture,
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    side: DoubleSide,
    roughness: 0.5,
    metalness: 0,
  });
  m.name = "livery-decal";
  return m;
}

export interface DecalMeshOptions extends DecalGeometryOptions {
  /** Aero level (car-mesh default 2). */
  aLvl?: number;
  parts?: PartTiers | null;
  legacyBody?: boolean;
  teamId?: TeamId;
  finShape?: string | null;
  spineHeight?: string | null;
  /** Shared material; one is made from `texture` otherwise. */
  material?: MeshStandardNodeMaterial;
}

/** The decal quads for one car as a Mesh drawn with the livery atlas. Add it to the car group beside the body. */
export function buildDecalMesh(texture: CanvasTexture, opts: DecalMeshOptions = {}): Mesh {
  const data = carDecalData(opts.aLvl == null ? 2 : Number(opts.aLvl), opts.parts, opts.legacyBody, opts.teamId,
    opts.finShape || "standard", opts.spineHeight);
  const geomOpts: DecalGeometryOptions = {};
  if (opts.mirrorX !== undefined) geomOpts.mirrorX = opts.mirrorX;
  const mesh = new Mesh(decalGeometry(data, geomOpts), opts.material ?? createDecalMaterial(texture));
  mesh.name = "car-decals";
  mesh.renderOrder = 1;   // after the opaque body, as drawDecal runs after the car
  return mesh;
}
