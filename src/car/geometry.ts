// Shared car mesh primitives and foil surfaces; create() receives the owner's surface
// and palette identities. Ported verbatim from f1-game js/car/car-geometry.js:4-294.
import type { Surfaces } from "./materials";
import type { MeshOut, Vec3 } from "./types";

/** Palette identities surfaceOf compares against (car-geometry.js:6). */
export interface GeometryContext {
  SURFACES: Surfaces;
  CARBON: Vec3; DARK: Vec3; INTAKE: Vec3; TYRE: Vec3; RIM: Vec3; HUB: Vec3;
  HALO: Vec3; VISOR: Vec3; PANEL: Vec3;
}

/** A loft station: centre (x, y) at z, width w, height h, top-width ratio t (car-geometry.js:81). */
export interface Station {
  z: number;
  y: number;
  w: number;
  h: number;
  t?: number | undefined;
  x?: number | undefined;
}

/** Wing foil recipe (car-geometry.js:102 foilAt). */
export interface FoilSpec {
  half: number;
  thick: number;
  zLead: number;
  zTrail: number;
  yLead: number;
  yTrail: number;
  sweep?: number | undefined;
  taper?: number | null | undefined;
  rise?: number | undefined;
  camber?: number | null | undefined;
  attachHalf?: number | null | undefined;
  teCurve?: number | undefined;
  chordTaper?: number | undefined;
  twist?: number | undefined;
}

export interface FoilPoint { x: number; y: number; z: number; h: number }

/** Surface id argument: null/undefined means "classify from the colour". */
export type SurfaceArg = number | null | undefined;
/** Colour argument where f1-game accepts a falsy "use the main colour". */
export type ColArg = Vec3 | null | undefined;

export function create(context: GeometryContext) {
  const { SURFACES, CARBON, DARK, INTAKE, TYRE, RIM, HUB, HALO, VISOR, PANEL } = context;

  function surfaceOf(col: Vec3, surface?: SurfaceArg): number {
    if (surface != null) return surface;
    if (col === CARBON || col === DARK || col === INTAKE) return SURFACES.carbon;
    if (col === TYRE) return SURFACES.rubber;
    if (col === RIM || col === HUB || col === HALO) return SURFACES.metal;
    if (col === VISOR) return SURFACES.glass;
    if (col === PANEL) return SURFACES.panel;
    return SURFACES.paint;
  }

  function addTri(out: MeshOut, a: Vec3, b: Vec3, c: Vec3, col: Vec3, surface?: SurfaceArg): void {
    const ux = b[0]-a[0], uy = b[1]-a[1], uz = b[2]-a[2];
    const vx = c[0]-a[0], vy = c[1]-a[1], vz = c[2]-a[2];
    let nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const base = out.pos.length / 3;
    const material = surfaceOf(col, surface);
    // Paint is reflective, not a light source: cap HDR accent colours on bodywork.
    const paint = material === SURFACES.paint;
    const r = paint ? Math.min(col[0], 1) : col[0], g = paint ? Math.min(col[1], 1) : col[1],
          bl = paint ? Math.min(col[2], 1) : col[2];
    out.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    out.nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    out.col.push(r, g, bl, r, g, bl, r, g, bl);
    out.mat.push(material, material, material);
    out.idx.push(base, base + 1, base + 2);
  }

  function addQuad(out: MeshOut, a: Vec3, b: Vec3, c: Vec3, d: Vec3, col: Vec3, surface?: SurfaceArg): void {
    addTri(out, a, b, c, col, surface);
    addTri(out, a, c, d, col, surface);
  }

  function addLoft(out: MeshOut, z0: number, x0: number, y0: number, w0: number, h0: number,
                   z1: number, x1: number, y1: number, w1: number, h1: number, col: Vec3, surface?: SurfaceArg): void {
    const b00: Vec3 = [x0-w0/2, y0-h0/2, z0], b10: Vec3 = [x0+w0/2, y0-h0/2, z0];
    const b11: Vec3 = [x0+w0/2, y0+h0/2, z0], b01: Vec3 = [x0-w0/2, y0+h0/2, z0];
    const f00: Vec3 = [x1-w1/2, y1-h1/2, z1], f10: Vec3 = [x1+w1/2, y1-h1/2, z1];
    const f11: Vec3 = [x1+w1/2, y1+h1/2, z1], f01: Vec3 = [x1-w1/2, y1+h1/2, z1];
    addQuad(out, f00, f10, f11, f01, col, surface); // front face (+Z)
    addQuad(out, b10, b00, b01, b11, col, surface); // back face  (-Z)
    addQuad(out, b01, f01, f11, b11, col, surface); // top        (+Y)
    addQuad(out, b00, b10, f10, f00, col, surface); // bottom     (-Y)
    addQuad(out, b10, b11, f11, f10, col, surface); // right      (+X)
    addQuad(out, b00, f00, f01, b01, col, surface); // left       (-X)
  }

  function addBox(out: MeshOut, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number,
                  col: Vec3, surface?: SurfaceArg): void {
    addLoft(out, cz-sz/2, cx, cy, sx, sy, cz+sz/2, cx, cy, sx, sy, col, surface);
  }

  /** Eight corners: front face q[0..3], rear face q[4..7] (car-geometry.js:62). */
  function addBlock(out: MeshOut, q: readonly Vec3[], col: Vec3, colFront?: ColArg, surface?: SurfaceArg,
                    frontSurface?: SurfaceArg, capFront?: boolean, capRear?: boolean): void {
    let Q = q as readonly [Vec3, Vec3, Vec3, Vec3, Vec3, Vec3, Vec3, Vec3];
    {
      const ax = Q[1][0]-Q[0][0], ay = Q[1][1]-Q[0][1], az = Q[1][2]-Q[0][2];
      const bx = Q[3][0]-Q[0][0], by = Q[3][1]-Q[0][1], bz = Q[3][2]-Q[0][2];
      const nx = ay*bz - az*by, ny = az*bx - ax*bz, nz = ax*by - ay*bx;
      const dx = Q[4][0]-Q[0][0], dy = Q[4][1]-Q[0][1], dz = Q[4][2]-Q[0][2];
      if (nx*dx + ny*dy + nz*dz > 0) Q = [Q[1], Q[0], Q[3], Q[2], Q[5], Q[4], Q[7], Q[6]];
    }
    if (capFront !== false)
      addQuad(out, Q[0], Q[1], Q[2], Q[3], colFront || col, frontSurface != null ? frontSurface : surface);  // front (+Z)
    if (capRear !== false)
      addQuad(out, Q[5], Q[4], Q[7], Q[6], col, surface);              // rear  (−Z)
    addQuad(out, Q[3], Q[2], Q[6], Q[7], col, surface);              // top   (+Y)
    addQuad(out, Q[1], Q[0], Q[4], Q[5], col, surface);              // bottom(−Y)
    addQuad(out, Q[1], Q[5], Q[6], Q[2], col, surface);              // right (+X)
    addQuad(out, Q[0], Q[3], Q[7], Q[4], col, surface);              // left  (−X)
  }
  function frame(f: Station): [Vec3, Vec3, Vec3, Vec3] {
    const w2 = f.w / 2, tw = (f.t !== undefined ? f.t : 1) * w2, x = f.x || 0;
    return [
      [x - w2, f.y - f.h / 2, f.z], [x + w2, f.y - f.h / 2, f.z],
      [x + tw, f.y + f.h / 2, f.z], [x - tw, f.y + f.h / 2, f.z],
    ];
  }
  function addSpan(out: MeshOut, front: Station, rear: Station, col: Vec3, colFront?: ColArg,
                   surface?: SurfaceArg, frontSurface?: SurfaceArg): void {
    const F = frame(front), R = frame(rear);
    addBlock(out, [F[0], F[1], F[2], F[3], R[0], R[1], R[2], R[3]], col, colFront, surface, frontSurface);
  }
  // Chordwise stations from leading to trailing edge, packed at both ends.
  const FOIL_T = [0, 0.08, 0.28, 0.60, 0.84, 1] as const;
  const FOIL_PEAK = Math.pow(0.5 / 1.6, 0.5) * Math.pow(1 - 0.5 / 1.6, 1.1);
  const foilThick = (t: number): number => Math.pow(t, 0.5) * Math.pow(1 - t, 1.1) / FOIL_PEAK;
  const FOIL_CAMBER = 0.05;
  // The foil SURFACE at spanwise x and chordwise t (car-geometry.js:102).
  function foilAt(spec: FoilSpec, x: number, t: number): FoilPoint {
    const half = spec.half, inner = half * 0.34;
    const sweep = spec.sweep || 0, taper = spec.taper == null ? 1 : spec.taper;
    const rise = spec.rise || 0, thick = spec.thick;
    const dz = spec.zLead - spec.zTrail, dy = spec.yTrail - spec.yLead;
    const chord = Math.hypot(dz, dy);
    const camber = (spec.camber == null ? FOIL_CAMBER : spec.camber) * chord;
    const edge = Math.max(0, (Math.abs(x) - inner) / Math.max(half - inner, 1e-6));
    const atTip = Math.abs(Math.abs(x) - half) < 1e-6;
    const attachedX = atTip && spec.attachHalf != null
      ? Math.sign(x || 1) * spec.attachHalf
      : null;
    const xF = attachedX != null ? attachedX : x;
    const xR = attachedX != null ? attachedX : x * taper;
    let yF = spec.yLead + rise * edge, yR = spec.yTrail + rise * edge;
    let zF = spec.zLead - sweep * edge, zR = spec.zTrail - sweep * edge;
    // teCurve pulls the TE toward the LE at the tip; chordTaper shortens the tip
    // chord; twist adds outboard incidence.
    if (spec.teCurve) zR += spec.teCurve * edge * edge;
    const ct = 1 - Math.max(0, spec.chordTaper || 0) * edge;
    if (ct < 1) { zR = zF + (zR - zF) * ct; yR = yF + (yR - yF) * ct; }
    const tw = (spec.twist || 0) * edge;
    if (tw) {
      // +Z forward, TE aft (dzc < 0): positive twist rotates the TE up (+Y).
      const dzc = zR - zF, dyc = yR - yF, c = Math.cos(tw), s = Math.sin(tw);
      zR = zF + dzc * c + dyc * s;
      yR = yF - dzc * s + dyc * c;
    }
    return {
      x: xF + (xR - xF) * t,
      y: yF + (yR - yF) * t - camber * 4 * t * (1 - t),
      z: zF + (zR - zF) * t,
      h: thick * 0.5 * foilThick(t),
    };
  }
  function addWingFoil(out: MeshOut, spec: FoilSpec, col: Vec3, surface?: SurfaceArg): void {
    const half = spec.half, mid = half * 0.67, inner = half * 0.34;
    const at = (x: number, t: number) => foilAt(spec, x, t);
    const segments = [[-half, -mid], [-mid, -inner], [-inner, inner], [inner, mid], [mid, half]] as const;
    for (const [x0, x1] of segments) {
      for (let i = 0; i < FOIL_T.length - 1; i++) {
        const t0 = FOIL_T[i]!, t1 = FOIL_T[i + 1]!;
        const a0 = at(x0, t0), b0 = at(x1, t0), b1 = at(x1, t1), a1 = at(x0, t1);
        const up = (p: FoilPoint): Vec3 => [p.x, p.y + p.h, p.z], dn = (p: FoilPoint): Vec3 => [p.x, p.y - p.h, p.z];
        // Upper surface wound so the normal points +Y, lower reversed.
        addQuad(out, up(a0), up(b0), up(b1), up(a1), col, surface);
        addQuad(out, dn(a0), dn(a1), dn(b1), dn(b0), col, surface);
      }
    }
  }
  function addStationLoft(out: MeshOut, stations: readonly (readonly Vec3[])[], col: Vec3, frontCol?: ColArg,
                          surface?: SurfaceArg, frontSurface?: SurfaceArg): void {
    for (let i = 0; i < stations.length - 1; i++) {
      addBlock(out, stations[i]!.concat(stations[i + 1]!), col,
               i === 0 ? frontCol : null, surface,
               i === 0 ? frontSurface : null,
               i === 0, i === stations.length - 2);
    }
  }
  // Chamfer the two TOP longitudinal edges of a span with proud 45° strips
  // (car-geometry.js:166). b in metres (chamfer width).
  function addTopBevel(out: MeshOut, front: Station, rear: Station, b: number, col: Vec3, surface?: SurfaceArg): void {
    const F = frame(front), R = frame(rear);
    for (const side of [1, -1]) {
      const ti = side > 0 ? 2 : 3;
      const fc = F[ti]!, rc = R[ti]!;
      const proud = 0.0006 * side;   // nudge outward in x so the crease wins depth
      const ft: Vec3 = [fc[0] - side * b + proud, fc[1], fc[2]];
      const fs: Vec3 = [fc[0] + proud, fc[1] - b, fc[2]];
      const rt: Vec3 = [rc[0] - side * b + proud, rc[1], rc[2]];
      const rs: Vec3 = [rc[0] + proud, rc[1] - b, rc[2]];
      // Wind so the facet normal points up-and-out (toward +y, ±x).
      if (side > 0) addQuad(out, fs, rs, rt, ft, col, surface);
      else          addQuad(out, ft, rt, rs, fs, col, surface);
    }
  }
  function addBeveledSpan(out: MeshOut, front: Station, rear: Station, b: number, col: Vec3, colFront?: ColArg,
                          surface?: SurfaceArg, frontSurface?: SurfaceArg): void {
    addSpan(out, front, rear, col, colFront, surface, frontSurface);
    if (b > 0) addTopBevel(out, front, rear, b, col, surface);
  }

  function addBeamBetween(out: MeshOut, p0: Vec3, p1: Vec3, th: number, col: Vec3, surface?: SurfaceArg): void {
    let dx = p1[0]-p0[0], dy = p1[1]-p0[1], dz = p1[2]-p0[2];
    const len = Math.hypot(dx, dy, dz) || 1; dx /= len; dy /= len; dz /= len;
    let ux = -dz, uy = 0, uz = dx;
    let ul = Math.hypot(ux, uy, uz);
    if (ul < 1e-5) { ux = 1; uy = 0; uz = 0; ul = 1; }
    ux = ux / ul * th * 0.5; uy = uy / ul * th * 0.5; uz = uz / ul * th * 0.5;
    // u already carries the half-thickness; crossing with unit d preserves it.
    const vx = dy*uz-dz*uy;
    const vy = dz*ux-dx*uz;
    const vz = dx*uy-dy*ux;
    const station = (p: Vec3): Vec3[] => [
      [p[0]-ux-vx,p[1]-uy-vy,p[2]-uz-vz], [p[0]+ux-vx,p[1]+uy-vy,p[2]+uz-vz],
      [p[0]+ux+vx,p[1]+uy+vy,p[2]+uz+vz], [p[0]-ux+vx,p[1]-uy+vy,p[2]-uz+vz],
    ];
    addBlock(out, station(p0).concat(station(p1)), col, null, surface);
  }

  function addFairedArm(out: MeshOut, p0: Vec3, p1: Vec3, th: number, col: Vec3, surface?: SurfaceArg): void {
    let dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;
    const chord = th * 2.5, thick = th * 0.58;
    let ax = -dx * dz, ay = -dy * dz, az = 1 - dz * dz;
    let al = Math.hypot(ax, ay, az);
    if (al < 1e-5) { ax = 1; ay = 0; az = 0; al = 1; }
    ax = ax / al * chord * 0.5;
    ay = ay / al * chord * 0.5;
    az = az / al * chord * 0.5;
    let lx = dy * az - dz * ay, ly = dz * ax - dx * az, lz = dx * ay - dy * ax;
    const ll = Math.hypot(lx, ly, lz) || 1;
    lx = lx / ll * thick * 0.5;
    ly = ly / ll * thick * 0.5;
    lz = lz / ll * thick * 0.5;
    const station = (p: Vec3): Vec3[] => [
      [p[0] - ax, p[1] - ay, p[2] - az],
      [p[0] - lx, p[1] - ly, p[2] - lz],
      [p[0] + ax, p[1] + ay, p[2] + az],
      [p[0] + lx, p[1] + ly, p[2] + lz],
    ];
    addBlock(out, station(p0).concat(station(p1)), col, null, surface);
  }

  // Carbon plate filling the V of a wishbone (leading + trailing legs → upright).
  function addWishboneWeb(out: MeshOut, inLead: Vec3, inTrail: Vec3, outer: Vec3, col: Vec3, surface?: SurfaceArg): void {
    const p = (a: Vec3, b: Vec3, t: number): Vec3 => [
      a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t,
    ];
    const a = p(inLead, outer, 0.40), b = p(inTrail, outer, 0.40);
    const c = p(inTrail, outer, 0.70), d = p(inLead, outer, 0.70);
    addQuad(out, a, b, c, d, col, surface);
    addQuad(out, a, d, c, b, col, surface);
  }

  // Smooth swept tube (the halo hoop): shared ring verts + radial normals, ring "up"
  // parallel-transported so frames never flip (car-geometry.js:242). No end caps.
  function addTube(out: MeshOut, path: readonly Vec3[], r: number, sides: number, col: Vec3, surface?: SurfaceArg): void {
    const i0 = out.pos.length / 3;
    const material = surfaceOf(col, surface);
    const rgb: Vec3 = material === SURFACES.paint
      ? [Math.min(col[0], 1), Math.min(col[1], 1), Math.min(col[2], 1)]
      : col;
    let ux = 0, uy = 1, uz = 0;
    for (let i = 0; i < path.length; i++) {
      const a = path[Math.max(0, i - 1)]!, b = path[Math.min(path.length - 1, i + 1)]!;
      let tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
      const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      const d = ux * tx + uy * ty + uz * tz;
      ux -= d * tx; uy -= d * ty; uz -= d * tz;
      let ul = Math.hypot(ux, uy, uz);
      if (ul < 1e-5) { ux = -tz; uy = 0; uz = tx; ul = Math.hypot(ux, uy, uz) || 1; }
      ux /= ul; uy /= ul; uz /= ul;
      const vx = ty * uz - tz * uy, vy = tz * ux - tx * uz, vz = tx * uy - ty * ux;
      const p = path[i]!;
      for (let s = 0; s < sides; s++) {
        const ang = (s / sides) * Math.PI * 2;
        const c = Math.cos(ang), sn = Math.sin(ang);
        const nx = ux * c + vx * sn, ny = uy * c + vy * sn, nz = uz * c + vz * sn;
        out.pos.push(p[0] + nx * r, p[1] + ny * r, p[2] + nz * r);
        out.nrm.push(nx, ny, nz);
        out.col.push(rgb[0], rgb[1], rgb[2]);
        out.mat.push(material);
      }
    }
    for (let i = 0; i < path.length - 1; i++) {
      for (let s = 0; s < sides; s++) {
        const s2 = (s + 1) % sides;
        const A = i0 + i * sides + s, B = i0 + i * sides + s2;
        const C = i0 + (i + 1) * sides + s2, D = i0 + (i + 1) * sides + s;
        out.idx.push(A, B, C, A, C, D);
      }
    }
  }

  return { addTri, addQuad, addLoft, addBox, addBlock, addSpan, foilThick, FOIL_CAMBER,
    foilAt, addWingFoil, addStationLoft, addTopBevel, addBeveledSpan, addBeamBetween,
    addFairedArm, addWishboneWeb, addTube };
}

export type CarGeometry = ReturnType<typeof create>;
export const CarGeometry = Object.freeze({ create });
