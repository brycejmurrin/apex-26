// Helmets: one painted helmet design per driver. Ported verbatim from f1-game
// js/car/helmets.js:1-831 (the `Helmets` IIFE becomes this module; the returned object
// at helmets.js:828 becomes the frozen `Helmets` export with the same member names).
//
// A helmet in the team's own paint is invisible at play distance; the helmet is the one
// part of the car that belongs to the PERSON and the only way to tell team-mates apart
// (helmets.js:3-8). A design is a BASE colour plus ZONES painted over it in order, each
// a region of the dome in helmet coordinates (helmets.js:10-14):
//   t    latitude, 0 at the crown, 1 at the bottom rim
//   az   azimuth in degrees: 0 FRONT, 90 the driver's right, 180 rear, 270 left
// Everything is evaluated per VERTEX into the car mesh's colour array: no texture, no
// draw call. Designs are keyed by RACE NUMBER; an unknown number gets one generated
// from the number itself, so every car on track has a distinct head (helmets.js:23-26).
import type { MeshOut, MVec3, Vec3 } from "./types";

// helmets.js:31. The palette the designs draw from. Named so a design reads as a sentence.
const C = {
  white:  [0.93, 0.94, 0.96], bone:   [0.86, 0.84, 0.78], silver: [0.66, 0.69, 0.74],
  black:  [0.07, 0.07, 0.08], carbon: [0.13, 0.14, 0.16], graphite: [0.24, 0.25, 0.28],
  red:    [0.85, 0.09, 0.11], crimson:[0.62, 0.05, 0.10], coral:  [0.95, 0.35, 0.30],
  orange: [0.98, 0.45, 0.05], papaya: [1.00, 0.50, 0.00], amber:  [0.95, 0.65, 0.10],
  yellow: [0.98, 0.84, 0.10], gold:   [0.83, 0.68, 0.22], lime:   [0.78, 0.92, 0.15],
  green:  [0.10, 0.60, 0.25], forest: [0.05, 0.35, 0.20], mint:   [0.35, 0.85, 0.55],
  teal:   [0.00, 0.71, 0.67], cyan:   [0.20, 0.80, 0.88], sky:    [0.45, 0.75, 0.95],
  blue:   [0.10, 0.35, 0.85], navy:   [0.05, 0.10, 0.32], royal:  [0.15, 0.25, 0.70],
  purple: [0.45, 0.20, 0.70], violet: [0.62, 0.35, 0.85], pink:   [0.95, 0.45, 0.72],
} as const satisfies Record<string, Vec3>;
export type HelmetColorName = keyof typeof C;

// ---- Zone records (helmets.js:186-194 factories) ----
export interface CapZone { k: "cap"; t1: number; c: Vec3 }
export interface BandZone { k: "band"; t0: number; t1: number; c: Vec3 }
export interface StripeZone { k: "stripe"; az: number; w: number; c: Vec3 }
export interface WedgeZone { k: "wedge"; az0: number; az1: number; c: Vec3 }
export interface ChevronZone { k: "chevron"; az: number; w: number; t0: number; t1: number; c: Vec3 }
export interface SpotZone { k: "spot"; az: number; t: number; r: number; c: Vec3 }
export interface PatchZone { k: "patch"; az: number; w: number; t0: number; t1: number; c: Vec3 }
export interface FlashZone { k: "flash"; az: number; w0: number; w1: number; t0: number; t1: number; sweep: number; c: Vec3 }
export interface MottleZone { k: "mottle"; t0: number; t1: number; sc: number; w: number; seed: number; c: Vec3 }
export type HelmetZone =
  | CapZone | BandZone | StripeZone | WedgeZone | ChevronZone | SpotZone | PatchZone | FlashZone | MottleZone;
export type HelmetZoneKind = HelmetZone["k"];

/** A helmet design (helmets.js:212 records, :349 generated(), :375 designFor shift). */
export interface HelmetDesign {
  name: string;
  base: Vec3;
  /** Base used instead when `base` is near the car's own paint (designFor). */
  alt?: Vec3 | undefined;
  visor: Vec3;
  zones: readonly HelmetZone[];
  generated?: boolean | undefined;
  shifted?: boolean | undefined;
}

/** Surface ids and detail switches build() takes (car3d.js:1268-1271 passes them). */
export interface HelmetBuildOptions {
  paint: number;
  glass: number;
  /** Field/shadow builds: base-only paint, coarse grid, no visor strip. */
  simplePaint?: boolean | undefined;
  /** Paint-edge subdivision depth; undefined means MAX_SPLIT. */
  maxSplit?: number | undefined;
  /** false builds the bare traced shell. */
  aero?: boolean | undefined;
}

/** One shell vertex's paint (helmets.js:431 shell()). */
export interface ShellSample { c: Vec3; glass: boolean }
export interface SurfPoint { p: MVec3; n: MVec3 }

// helmets.js:45-52. Shortest angle between two azimuths, 0..180; the +540 wrap keeps a
// negative modulus off the result, so a stripe over the nose is the same width at 359 or 1.
const dAz = (a: number, b: number): number => Math.abs(((a - b) % 360 + 540) % 360 - 180);
const inAz = (az: number, a0: number, a1: number): boolean => {
  const s = ((a0 % 360) + 360) % 360, e = ((a1 % 360) + 360) % 360, p = ((az % 360) + 360) % 360;
  return s <= e ? (p >= s && p <= e) : (p >= s || p <= e);
};

// helmets.js:53-118. Each returns true where it paints. `az` wraps.
const ZONES = {
  // the crown, down to latitude t1
  cap: (z: CapZone, t: number): boolean => t <= z.t1,
  // a ring around the shell
  band: (z: BandZone, t: number): boolean => t >= z.t0 && t <= z.t1,
  // crown-to-rim stripe centred on an azimuth; 0 and 180 make the centre stripe
  stripe: (z: StripeZone, t: number, az: number): boolean => dAz(az, z.az) <= z.w,
  // an azimuth sector: halves, quarters, a painted temple
  wedge: (z: WedgeZone, t: number, az: number): boolean => inAz(az, z.az0, z.az1),
  // a V that opens as it runs down the face
  chevron: (z: ChevronZone, t: number, az: number): boolean => t >= z.t0 && t <= z.t1 &&
    dAz(az, z.az) <= z.w * (0.15 + 0.85 * (t - z.t0) / Math.max(1e-3, z.t1 - z.t0)),
  // a round patch; azimuth width scaled by sin(latitude) so it stays round toward the pole
  spot: (z: SpotZone, t: number, az: number): boolean => {
    const lat = Math.max(0.15, Math.sin(t * Math.PI / 2));
    const x = dAz(az, z.az) / 90 * lat, y = t - z.t;
    return x * x + y * y <= z.r * z.r;
  },
  // a rectangle in (t, az): lets a design put a mark SOMEWHERE rather than round the head
  patch: (z: PatchZone, t: number, az: number): boolean => t >= z.t0 && t <= z.t1 && dAz(az, z.az) <= z.w,
  // a stripe that sweeps and tapers down the shell: the shape modern lids are built from,
  // which a band and a stripe together cannot make
  flash: (z: FlashZone, t: number, az: number): boolean => {
    if (t < z.t0 || t > z.t1) return false;
    const f = (t - z.t0) / Math.max(1e-3, z.t1 - z.t0);
    return dAz(az, z.az + z.sweep * f) <= z.w0 + (z.w1 - z.w0) * f;
  },
  // A DOODLE, NOT A SPECKLE (helmets.js:87-108): a per-cell hash reads as static; a
  // LEVEL SET of a smooth field gives connected, evenly wide strokes. Integer azimuthal
  // frequencies keep it seamless; closed form keeps it resolution-free and deterministic.
  // The t coefficients are deliberately low (scaled 0.6): faster reads as speckle,
  // slower smears into vertical streaks.
  //   sc  wavelengths round the shell (feature size)
  //   w   half-width of the stroke, in field units (ink coverage)
  mottle: (z: MottleZone, t: number, az: number): boolean => {
    if (t < z.t0 || t > z.t1) return false;
    const th = (((az % 360) + 360) % 360) * Math.PI / 180, u = t * Math.PI, k = z.seed;
    const f = Math.sin(z.sc * th + 3.06 * u + k)
            + Math.sin((z.sc + 2) * th - 1.98 * u + 1.7 * k + 1.1)
            + 0.8 * Math.sin((z.sc - 1) * th + 5.40 * u + 0.7 * k + 4.2)
            + 0.7 * Math.sin((z.sc + 4) * th + 1.26 * u + 1.3 * k + 2.4);
    return Math.abs(f) < z.w;
  },
};
type ZoneTest = (z: HelmetZone, t: number, az: number) => boolean;

// helmets.js:165-184. SNAP A HORIZONTAL EDGE ONTO A RING: each triangle carries one flat
// colour, so a band edge mid-row catches alternate diagonal-split triangles and reads as a
// sawtooth. Snapped to the nearest ring the edge is the mesh's own edge. A band is always
// widened to at least one whole row, so a keyline cannot snap itself out of existence.
const RINGS = 20, SLICES = 28;
const FIELD_RINGS = 12, FIELD_SLICES = 18;
const ringT = (i: number): number => Math.pow(i / RINGS, 1.25);
const RING_TS = Array.from({ length: RINGS + 1 }, (_, i) => ringT(i));
const snapT = (t: number): number =>
  RING_TS.reduce((a, v) => (Math.abs(v - t) < Math.abs(a - t) ? v : a), RING_TS[0]!);
const snapBand = (t0: number, t1: number): [number, number] => {
  let a = snapT(t0), b = snapT(t1);
  if (b <= a) { const i = RING_TS.indexOf(a); b = RING_TS[Math.min(RING_TS.length - 1, i + 1)]!; }
  return [a, b];
};
// helmets.js:185-205 zone factories.
const z = {
  cap: (t1: number, c: Vec3): CapZone => ({ k: "cap", t1: snapT(t1), c }),
  band: (t0: number, t1: number, c: Vec3): BandZone => { const b = snapBand(t0, t1); return { k: "band", t0: b[0], t1: b[1], c }; },
  stripe: (az: number, w: number, c: Vec3): StripeZone => ({ k: "stripe", az, w, c }),
  wedge: (az0: number, az1: number, c: Vec3): WedgeZone => ({ k: "wedge", az0, az1, c }),
  chevron: (az: number, w: number, t0: number, t1: number, c: Vec3): ChevronZone => ({ k: "chevron", az, w, t0, t1, c }),
  spot: (az: number, t: number, r: number, c: Vec3): SpotZone => ({ k: "spot", az, t, r, c }),
  patch: (az: number, w: number, t0: number, t1: number, c: Vec3): PatchZone => ({ k: "patch", az, w, t0, t1, c }),
  flash: (az: number, w0: number, w1: number, t0: number, t1: number, sweep: number, c: Vec3): FlashZone =>
    ({ k: "flash", az, w0, w1, t0, t1, sweep, c }),
  mottle: (t0: number, t1: number, sc: number, w: number, seed: number, c: Vec3): MottleZone =>
    ({ k: "mottle", t0, t1, sc, w, seed, c }),
  // A KEYLINE: the thin second-colour line that makes a graphic read as a paint job.
  // 0.055 wide: under the ring spacing a keyline has no vertex to live on and vanishes.
  key: (t: number, c: Vec3): BandZone => { const b = snapBand(t, t + 0.055); return { k: "band", t0: b[0], t1: b[1], c }; },
  // The pair on both temples; writing them twice is how one ends up 4 degrees off.
  sides: <T>(f: (a: number) => T): [T, T] => [f(90), f(270)],
};
// A centre stripe is the pair: over the nose and over the tail.
const centre = (w: number, c: Vec3): [StripeZone, StripeZone] => [z.stripe(0, w, c), z.stripe(180, w, c)];

// helmets.js:120-323. The grid, read off reference photographs (tools/car/helmet-trace.mjs
// measured palettes). Base, where the shell changes colour, and the one or two marks
// that tell the pair apart survive to play distance; no lettering, no logos.
// ONE DRIVER IN THREE WEARS HIS OWN CAR: those take the real design's SECOND colour as
// base so the lid does not vanish into the car; near() is the check.
// The VISOR OWNS t 0.40-0.66 across the front 76 degrees, so face chevrons stop at 0.44
// and marks below it are bands at 0.68 and down.
const DESIGNS: Readonly<Record<number, HelmetDesign>> = {
  // Mercedes: a sky-blue crown over a navy lower two-thirds, white flashes
  // raked back off the temples, the join picked out in white.
  63: { name: "RUS", base: C.sky, alt: C.white, visor: C.black, zones: [
    z.band(0.56, 0.955, C.navy), z.key(0.505, C.white), z.patch(180, 34, 0.16, 0.40, C.navy),
    ...z.sides((a) => z.flash(a, 8, 20, 0.10, 0.55, 24, C.white)), ...centre(9, C.white), z.key(0.90, C.sky)] },
  // Mercedes: navy under a white crown, the tricolore run down the brow, an
  // orange skirt at the rim.
  12: { name: "ANT", base: C.royal, alt: C.sky, visor: C.silver, zones: [
    z.cap(0.20, C.white), z.key(0.20, C.carbon), z.flash(0, 10, 46, 0.14, 0.44, 0, C.orange),
    z.flash(0, 5, 24, 0.14, 0.44, 0, C.white), ...z.sides((a) => z.patch(a, 22, 0.26, 0.40, C.white)),
    z.band(0.70, 0.80, C.white), z.key(0.80, C.carbon), z.band(0.88, 0.955, C.orange)] },
  // Ferrari: red to the brow, white below it, black under the aperture. The
  // base is the WHITE half so the lid separates from the car (see near()).
  16: { name: "LEC", base: C.white, alt: C.navy, visor: C.black, zones: [
    z.cap(0.42, C.red), z.key(0.420, C.black), ...z.sides((a) => z.flash(a, 6, 16, 0.10, 0.39, 24, C.white)),
    z.band(0.68, 0.76, C.black), z.key(0.76, C.red), ...centre(7, C.black), z.band(0.90, 0.955, C.red)] },
  // Ferrari: the plain yellow lid. Almost all of the design is the absence of
  // one: a black line under the aperture, a white centre, a red skirt.
  44: { name: "HAM", base: C.yellow, alt: C.violet, visor: C.black, zones: [
    ...centre(10, C.white), ...z.sides((a) => z.flash(a, 5, 14, 0.08, 0.42, 24, C.black)),
    z.band(0.68, 0.74, C.black), z.key(0.74, C.white), z.band(0.90, 0.955, C.red)] },
  // McLaren: fluoro lime under a black doodle. sc 5 / w 0.48 is swept
  // against a reference photo: 5 sets the loop size, 0.48 the ink.
   1: { name: "NOR", base: C.lime, alt: C.cyan, visor: C.black, zones: [
    z.mottle(0.06, 0.95, 5, 0.48, 3, C.black), z.cap(0.09, C.black),
    ...z.sides((a) => z.patch(a, 13, 0.20, 0.60, C.black)),
    z.key(0.74, C.papaya), z.band(0.86, 0.92, C.black), z.key(0.92, C.papaya)] },
  // McLaren: black shell, papaya crown and face flash, a lime skirt.
  81: { name: "PIA", base: C.carbon, alt: C.teal, visor: C.amber, zones: [
    z.cap(0.13, C.papaya), z.key(0.13, C.lime), z.flash(0, 8, 30, 0.14, 0.42, 0, C.papaya),
    ...z.sides((a) => z.flash(a, 6, 16, 0.16, 0.58, 24, C.papaya)),
    z.band(0.78, 0.88, C.lime), z.key(0.745, C.papaya), z.band(0.90, 0.955, C.papaya)] },
  // Red Bull: navy crown, red face flash, white band. Royal rather than navy
  // as the base, or it vanishes into a Red Bull.
   3: { name: "VER", base: C.royal, alt: C.orange, visor: C.black, zones: [
    z.cap(0.22, C.red), z.key(0.22, C.white), z.flash(0, 12, 46, 0.16, 0.44, 0, C.navy),
    ...z.sides((a) => z.flash(a, 9, 24, 0.18, 0.62, 24, C.navy)),
    z.band(0.68, 0.80, C.white), z.key(0.625, C.navy), z.band(0.88, 0.955, C.navy)] },
  // Red Bull: fluoro lime with a navy crown and an orange flash.
   6: { name: "HAD", base: C.white, alt: C.royal, visor: C.black, zones: [
    z.cap(0.42, C.carbon), z.key(0.42, C.lime), z.flash(0, 10, 34, 0.16, 0.40, 0, C.lime),
    ...z.sides((a) => z.flash(a, 8, 20, 0.16, 0.40, 24, C.lime)),
    z.band(0.66, 0.86, C.carbon), z.key(0.605, C.lime), z.band(0.88, 0.955, C.navy)] },
  // Alpine: pale blue mottle over a navy lower half, pink at the rim.
  10: { name: "GAS", base: C.sky, alt: C.white, visor: C.silver, zones: [
    z.mottle(0.04, 0.58, 6, 0.40, 7, C.white), z.band(0.60, 0.90, C.navy), z.key(0.545, C.white),
    ...z.sides((a) => z.flash(a, 7, 18, 0.14, 0.57, 24, C.white)), ...centre(8, C.white),
    z.band(0.90, 0.955, C.pink)] },
  // Alpine: Argentine white and sky blue, pink down the centre.
  43: { name: "COL", base: C.white, alt: C.crimson, visor: C.black, zones: [
    z.band(0.24, 0.40, C.sky), z.key(0.185, C.navy), z.key(0.40, C.navy),
    ...z.sides((a) => z.flash(a, 6, 16, 0.12, 0.39, 24, C.pink)), ...centre(10, C.pink),
    z.band(0.68, 0.82, C.navy), z.key(0.82, C.sky), z.band(0.90, 0.955, C.navy)] },
  // Racing Bulls: pink over white, navy skirt.
  30: { name: "LAW", base: C.pink, alt: C.forest, visor: C.silver, zones: [
    z.cap(0.16, C.white), z.key(0.16, C.navy), ...z.sides((a) => z.flash(a, 8, 22, 0.16, 0.60, 24, C.white)),
    z.band(0.66, 0.88, C.white), z.key(0.605, C.navy), ...centre(7, C.navy), z.band(0.88, 0.955, C.navy)] },
  // Racing Bulls: sky blue, navy crown, a red centre.
  41: { name: "LIN", base: C.sky, alt: C.crimson, visor: C.black, zones: [
    z.cap(0.24, C.navy), z.key(0.24, C.gold), ...z.sides((a) => z.flash(a, 7, 20, 0.16, 0.58, 24, C.navy)),
    ...centre(9, C.gold), z.band(0.70, 0.84, C.white), z.key(0.84, C.navy), z.band(0.90, 0.955, C.navy)] },
  // Haas: red with a carbon crown and skirt, white down the centre.
  31: { name: "OCO", base: C.red, alt: C.white, visor: C.black, zones: [
    z.cap(0.16, C.carbon), z.key(0.16, C.white), ...z.sides((a) => z.flash(a, 8, 22, 0.18, 0.62, 24, C.carbon)),
    ...centre(10, C.white), z.band(0.72, 0.88, C.carbon), z.key(0.665, C.white), z.band(0.90, 0.955, C.white)] },
  // Haas: navy-blue with fluoro lime through the face and the jaw.
  87: { name: "BEA", base: C.royal, alt: C.coral, visor: C.black, zones: [
    z.cap(0.16, C.carbon), z.key(0.16, C.lime), z.flash(0, 9, 32, 0.12, 0.42, 0, C.lime),
    ...z.sides((a) => z.flash(a, 7, 16, 0.16, 0.58, 24, C.lime)),
    z.band(0.66, 0.86, C.white), z.key(0.605, C.carbon), z.band(0.88, 0.955, C.carbon)] },
  // Williams: navy with the Spanish red-and-yellow doubled down the face and
  // raked back over each temple.
  55: { name: "SAI", base: C.navy, alt: C.mint, visor: C.black, zones: [
    z.flash(0, 9, 30, 0.14, 0.42, 0, C.yellow), z.flash(0, 4, 13, 0.14, 0.42, 0, C.red),
    ...z.sides((a) => z.flash(a, 7, 16, 0.16, 0.60, 24, C.yellow)),
    z.band(0.66, 0.86, C.white), z.key(0.605, C.royal), z.band(0.88, 0.955, C.navy)] },
  // Williams: pale pink under a white crown, royal-blue graphics, navy jaw.
  23: { name: "ALB", base: C.white, alt: C.forest, visor: C.gold, zones: [
    z.cap(0.22, C.pink), z.key(0.22, C.navy), z.flash(0, 10, 38, 0.14, 0.44, 0, C.royal),
    ...z.sides((a) => z.flash(a, 8, 20, 0.16, 0.60, 24, C.pink)),
    z.band(0.72, 0.86, C.navy), z.key(0.665, C.pink), z.band(0.90, 0.955, C.white)] },
  // Audi: black with green graphics and a scatter of white stars. Graphite
  // rather than black, or it is an Audi-coloured lid in an Audi.
  27: { name: "HUL", base: C.graphite, alt: C.white, visor: C.black, zones: [
    z.cap(0.10, C.black), z.flash(0, 10, 34, 0.12, 0.44, 0, C.green),
    ...z.sides((a) => z.flash(a, 7, 18, 0.16, 0.60, 24, C.green)),
    z.mottle(0.10, 0.62, 11, 0.12, 11, C.white), z.band(0.84, 0.955, C.green), z.key(0.785, C.white)] },
  // Audi: white with a Brazilian green crown and yellow keyline, navy jaw.
   5: { name: "BOR", base: C.white, alt: C.crimson, visor: C.black, zones: [
    z.cap(0.17, C.green), z.key(0.17, C.yellow),
    ...z.sides((a) => z.flash(a, 8, 20, 0.16, 0.60, 24, C.carbon)),
    z.band(0.68, 0.86, C.carbon), z.key(0.625, C.yellow), z.band(0.88, 0.955, C.green)] },
  // Aston Martin: cyan with a yellow brow band and an orange skirt.
  14: { name: "ALO", base: C.cyan, alt: C.crimson, visor: C.gold, zones: [
    z.cap(0.20, C.navy), z.band(0.24, 0.38, C.yellow), z.key(0.185, C.yellow), z.key(0.38, C.navy),
    ...z.sides((a) => z.flash(a, 8, 20, 0.16, 0.60, 24, C.gold)),
    z.band(0.66, 0.84, C.white), z.key(0.605, C.navy), z.band(0.88, 0.955, C.navy)] },
  // Aston Martin: near-black with the team's green through the centre.
  18: { name: "STR", base: C.carbon, alt: C.coral, visor: C.black, zones: [
    z.cap(0.14, C.forest), z.key(0.14, C.silver), ...centre(11, C.forest),
    ...z.sides((a) => z.flash(a, 7, 18, 0.16, 0.60, 24, C.forest)),
    z.band(0.68, 0.80, C.forest), z.key(0.80, C.silver), z.band(0.90, 0.955, C.silver)] },
  // Cadillac: fluoro lime with a black crown and face, red at the rim.
  11: { name: "PER", base: C.lime, alt: C.royal, visor: C.black, zones: [
    z.cap(0.22, C.black), z.key(0.22, C.white), z.flash(0, 12, 40, 0.18, 0.46, 0, C.black),
    ...z.sides((a) => z.flash(a, 9, 24, 0.18, 0.62, 24, C.black)),
    z.band(0.70, 0.84, C.black), z.key(0.645, C.navy), z.band(0.88, 0.955, C.navy)] },
  // Cadillac: black with blue through it. Royal as the base, or it is a black
  // lid in a black car.
  77: { name: "BOT", base: C.royal, alt: C.amber, visor: C.silver, zones: [
    z.cap(0.26, C.black), z.key(0.26, C.sky), z.flash(0, 14, 50, 0.14, 0.46, 0, C.black),
    ...z.sides((a) => z.flash(a, 12, 30, 0.16, 0.64, 24, C.black)),
    z.band(0.66, 0.88, C.black), z.key(0.605, C.sky), z.band(0.88, 0.955, C.sky)] },
};

// helmets.js:325-350. A number nobody on the 2026 grid carries: deterministic in the
// number, so the same driver keeps the same head, built from the same vocabulary.
const WHEEL: readonly Vec3[] = [C.red, C.blue, C.yellow, C.white, C.green, C.violet, C.orange, C.cyan, C.pink, C.lime, C.teal, C.crimson];
const pick = (n: number, off: number): Vec3 =>
  WHEEL[(((n * 7 + off * 5) % WHEEL.length) + WHEEL.length) % WHEEL.length]!;
function generated(num: number, name?: string): HelmetDesign {
  const n = Math.abs(num | 0);
  const base = pick(n, 0), mark = pick(n + 3, 1), trim = pick(n + 7, 2);
  const zones = ([[z.cap(0.24, mark), ...centre(10, trim)],
                 [z.band(0.26, 0.40, mark), z.band(0.72, 0.84, trim)],
                 [z.chevron(0, 40, 0.20, 0.66, mark), z.band(0.70, 0.82, trim)],
                 [z.wedge(200, 340, mark), z.cap(0.18, trim)]] as HelmetZone[][])[n % 4]!;
  // AN `alt`, LIKE EVERY HAND-AUTHORED DESIGN HAS: designFor() short-circuits on `!d.alt`,
  // so without one a generated helmet never shifted off a car it matched (a lime helmet
  // in a lime MY TEAM car). Six steps round a twelve-entry wheel is the opposite hue, so
  // it cannot equal `base`; chosen, not computed, for the reason at designFor.
  const alt = WHEEL[(((n * 7) % WHEEL.length) + WHEEL.length + WHEEL.length / 2) % WHEEL.length]!;
  return { name: name || "#" + n, base, alt, visor: C.black, zones, generated: true };
}

/** helmets.js:352-360. A string key as a number, for a head that belongs to a person
 *  rather than a seat (a legend's code): race numbers are not stable across eras.
 *  FNV-1a, folded to 31 bits. */
function keyNum(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 1);
}

// helmets.js:362-376. `teamC` is the car's own primary paint. A design whose base is near
// it switches to its `alt` base, CHOSEN rather than computed: multiplying toward
// white/black turned Leclerc salmon and Antonelli's tricolore into greys on grey.
const near = (a: Vec3, b: Vec3): boolean => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 0.30;
function designFor(num: number | null | undefined, teamC?: Vec3 | null, key?: string | number | null): HelmetDesign {
  // `key` (a legend code) is never a 2026 driver's design, whatever its number.
  const d = (key != null && generated(keyNum(String(key)), String(key))) ||
            (num != null && DESIGNS[num]) || generated(num == null ? 0 : num);
  if (!teamC || !d.alt || !near(d.base, teamC)) return d;
  return { name: d.name, base: d.alt, visor: d.visor, zones: d.zones, generated: d.generated, shifted: true };
}

/** helmets.js:378-391. (t, az) -> colour. Zones paint in order, so a later one covers an
 *  earlier one as a painter's masks would. The base where nothing claims the vertex. */
function painter(design: HelmetDesign): (t: number, az: number) => Vec3 {
  const zones = design.zones || [];
  return function (t: number, az: number): Vec3 {
    let c = design.base;
    for (let i = 0; i < zones.length; i++) {
      const zz = zones[i]!, test = (ZONES as unknown as Record<string, ZoneTest | undefined>)[zz.k];
      if (test && test(zz, t, az)) c = zz.c;
    }
    return c;
  };
}

// helmets.js:393-429. THE VISOR IS PART OF THE PAINTED SHELL, not a box bolted on (a slab
// wider than the head reads as a lump). As a region it takes the aperture's real shape,
// every design paints around it, and its vertices get the glass surface.
const TRIM: Vec3 = [0.10, 0.10, 0.11];
const VISOR_T0 = 0.40, VISOR_T1 = 0.66, VISOR_AZ = 76;   // measured off the front mockup: 40% to 66% down
// The aperture, optionally GROWN by a margin: grown by a hair it gives the gasket, the
// dark surround that makes the visor read as a hole rather than a patch of paint.
function visorAt(t: number, az: number, grow: number): boolean {
  const t0 = VISOR_T0 - grow, t1 = VISOR_T1 + grow;
  if (t < t0 || t > t1) return false;
  const f = (t - t0) / (t1 - t0);
  return dAz(az, 0) <= (VISOR_AZ + grow * 110) * Math.min(1, 1.55 * Math.sin(Math.PI * f));
}
const isVisorEdge = (t: number, az: number): boolean => !visorAt(t, az, 0) && visorAt(t, az, 0.020);
function isVisor(t: number, az: number): boolean {
  if (t < VISOR_T0 || t > VISOR_T1) return false;
  // A LENS, not a rectangle: widest across the eyes, closing at brow and nose. Wider
  // (AZ 80, 3.2 ramp) it read as a blindfold; narrower as a letterbox slot. The 1.55
  // ramp holds full width across the middle half.
  const f = (t - VISOR_T0) / (VISOR_T1 - VISOR_T0);
  return dAz(az, 0) <= VISOR_AZ * Math.min(1, 1.55 * Math.sin(Math.PI * f));
}

/** helmets.js:431-442. (t, az) -> { c, glass }: the design's paint, or the visor. */
function shell(design: HelmetDesign): (t: number, az: number) => ShellSample {
  const paint = painter(design);
  const visor = design.visor || C.black;
  return function (t: number, az: number): ShellSample {
    if (isVisor(t, az)) return { c: visor, glass: true };
    if (isVisorEdge(t, az)) return { c: TRIM, glass: false };   // the gasket round the eye port
    if (t >= 0.955) return { c: TRIM, glass: false };   // the dark band round the neck opening
    return { c: paint(t, az), glass: false };
  };
}

// helmets.js:444-505. The shape, TRACED from photographs (eleven side-on silhouettes
// reduced to a median), not judged by eye: the profile is smooth (the face reads from
// paint, not bumps), fattest low at ~60% height, near-symmetric front to back, length
// 1.21x height, rim two thirds of max length. Cross-section is a mild superellipse
// |x/w|^n + |z/d|^n = 1 (above 2.4 it read as a bucket). W is traced off a front shot.
// The rim is cut at 97% height; the crown row is closed to a point, not traced.
//   t   0 at the crown, 1 at the neck rim
//   Y   height above the temple line, metres
//   W   half width; F reach ahead of centre; B reach behind; N squareness
const SHAPE = {
  T: [0.000, 0.012, 0.028, 0.050, 0.080, 0.120, 0.170, 0.230, 0.300, 0.380, 0.460, 0.540, 0.620, 0.700, 0.780, 0.850, 0.910, 0.960, 1.000],
  Y: [0.119, 0.116, 0.112, 0.106, 0.099, 0.089, 0.076, 0.061, 0.043, 0.023, 0.003, -0.017, -0.037, -0.057, -0.078, -0.095, -0.110, -0.123, -0.133],
  W: [0.000, 0.013, 0.031, 0.046, 0.058, 0.070, 0.080, 0.089, 0.097, 0.103, 0.104, 0.104, 0.103, 0.100, 0.096, 0.090, 0.081, 0.067, 0.056],
  F: [0.000, 0.023, 0.037, 0.051, 0.072, 0.090, 0.109, 0.120, 0.126, 0.131, 0.144, 0.152, 0.158, 0.157, 0.151, 0.142, 0.133, 0.121, 0.114],
  B: [0.000, 0.023, 0.038, 0.052, 0.070, 0.075, 0.092, 0.110, 0.127, 0.140, 0.146, 0.149, 0.157, 0.155, 0.148, 0.141, 0.132, 0.123, 0.116],
  N: [2.05, 2.06, 2.08, 2.11, 2.14, 2.17, 2.20, 2.23, 2.25, 2.26, 2.26, 2.25, 2.23, 2.20, 2.16, 2.13, 2.10, 2.07, 2.05],
} satisfies Record<string, number[]>;
export type HelmetShape = typeof SHAPE;

// helmets.js:506-524. Reads a profile column at any t. CATMULL-ROM, not linear: linear
// creases at every row (at the crown it read as a flat cap). Ends clamp by repeating
// the end row, which holds the flat cut at the neck.
function tab(arr: readonly number[], t: number): number {
  const T = SHAPE.T, n = T.length;
  if (t <= T[0]!) return arr[0]!;
  if (t >= T[n - 1]!) return arr[n - 1]!;
  let i = 1;
  while (i < n - 1 && t > T[i]!) i++;
  const f = (t - T[i - 1]!) / (T[i]! - T[i - 1]!);
  const p0 = arr[Math.max(0, i - 2)]!, p1 = arr[i - 1]!, p2 = arr[i]!, p3 = arr[Math.min(n - 1, i + 1)]!;
  const f2 = f * f, f3 = f2 * f;
  return 0.5 * ((2 * p1) + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 + (-p0 + 3 * p1 - 3 * p2 + p3) * f3);
}
// helmets.js:528-537. SIZE, separate from shape: Car3D's body is proportionally taller
// than a real car, so 1.107 puts the lid on the real lid:car height ratio
// (0.279 tall, 0.230 wide, 0.349 long).
const SCALE = 1.107;
/** helmets.js:525-544. A point on the shell. `a` is azimuth in RADIANS, 0 over the nose,
 *  growing toward the driver's right; the superellipse is solved along that direction. */
function pointAt(t: number, a: number): MVec3 {
  const w = Math.max(1e-4, tab(SHAPE.W, t) * SCALE), n = tab(SHAPE.N, t);
  const dx = Math.sin(a), dz = Math.cos(a);
  const d = Math.max(1e-4, (dz >= 0 ? tab(SHAPE.F, t) : tab(SHAPE.B, t)) * SCALE);
  const r = 1 / Math.pow(Math.pow(Math.abs(dx / w), n) + Math.pow(Math.abs(dz / d), n), 1 / n);
  return [r * dx, tab(SHAPE.Y, t) * SCALE, r * dz];
}

// helmets.js:546-634. THE MESH IS THE CEILING ON THE DESIGN: per-vertex colour only draws
// what a vertex lands on, so 20 x 28 (gaps ~0.05 in t, 12.9 deg) is what keylines and
// temple flashes need; f^1.25 lands the first ring inside the blunt crown.
// FLAT PAINT, SMOOTH LIGHT: each triangle has its own three vertices coloured at its
// CENTROID (crisp mesh-edge paint) while normals stay smooth per corner.
// WHERE THE PAINT CHANGES, SPLIT THE QUAD: a base quad recurses only while its corners
// and centre disagree, so triangles land on boundary lines (~2.3x per level, not 4x).
// MAX_SPLIT 1 is measured at the size the helmet is seen (~110 px cockpit view): depth 2
// is barely separable and costs more than the rest of the car. Past depth 1 the fix is
// per-fragment paint (a renderer change; see helmets.js:600-629 for its two traps).
// The base grid still sets the normals' finite-difference step, so subdivision changes
// the paint and never the lighting.
const MAX_SPLIT = 1;

// helmets.js:636-653. THE AERO A REAL LID CARRIES, which the traced outline cannot: the
// chase camera mostly sees back and top, where a bare ovoid reads as a ball. Three small
// lofts rooted ON the shell through pointAt() (rear gurney at t 0.30 az 180+-42, top
// intake on the crown centreline, visor strip along the eye port's upper edge). Paint is
// the design's own at each root; mouth, lip underside and strip are dark. Field/shadow
// builds (simplePaint) keep the two silhouette parts and drop the strip.
/** helmets.js:654-663. Shell point and outward unit normal at (t, az degrees). */
function surfAt(t: number, az: number): SurfPoint {
  const a = az * Math.PI / 180, e = 0.01, ea = 0.02;
  const p = pointAt(t, a);
  const pu = pointAt(Math.min(1, t + e), a), pd = pointAt(Math.max(0, t - e), a);
  const pr = pointAt(t, a + ea), pl = pointAt(t, a - ea);
  const tu = [pu[0] - pd[0], pu[1] - pd[1], pu[2] - pd[2]] as const, ta = [pr[0] - pl[0], pr[1] - pl[1], pr[2] - pl[2]] as const;
  const n = [ta[1] * tu[2] - ta[2] * tu[1], ta[2] * tu[0] - ta[0] * tu[2], ta[0] * tu[1] - ta[1] * tu[0]] as const;
  const m = Math.hypot(n[0], n[1], n[2]) || 1;
  return { p, n: [n[0] / m, n[1] / m, n[2] / m] };
}
const _add = (p: Vec3, n: Vec3, k: number): MVec3 => [p[0] + n[0] * k, p[1] + n[1] * k, p[2] + n[2] * k];
// The azimuth (degrees) at which ring t is `w` metres off the centre plane.
function azAtHalfWidth(t: number, w: number): number {
  let lo = 0, hi = 90;
  for (let k = 0; k < 24; k++) { const m = (lo + hi) / 2; if (pointAt(t, m * Math.PI / 180)[0] < w) lo = m; else hi = m; }
  return (lo + hi) / 2;
}
const AERO_DARK: Vec3 = [0.05, 0.05, 0.06];
/** helmets.js:672-748. Gurney, intake and (unless simplePaint) visor strip, appended to out. */
function buildAero(out: MeshOut, cx: number, cy: number, cz: number, design: HelmetDesign,
                   S: HelmetBuildOptions, simplePaint?: boolean): MeshOut {
  const paint = simplePaint ? (): Vec3 => design.base : painter(design);
  // One flat triangle, wound so its face normal leans the way `ref` says is
  // outward: the shell's own convention (counter-clockwise from outside).
  const tri = (a: Vec3, b: Vec3, c: Vec3, col: Vec3, ref: Vec3): void => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const, v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const;
    let n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const m = Math.hypot(n[0], n[1], n[2]);
    if (m < 1e-12) return;
    n = [n[0] / m, n[1] / m, n[2] / m];
    if (n[0] * ref[0] + n[1] * ref[1] + n[2] * ref[2] < 0) { const s = b; b = c; c = s; n = [-n[0], -n[1], -n[2]]; }
    const i = out.pos.length / 3, cc = [Math.min(col[0], 1), Math.min(col[1], 1), Math.min(col[2], 1)] as const;
    for (const q of [a, b, c]) {
      out.pos.push(cx + q[0], cy + q[1], cz + q[2]); out.nrm.push(n[0], n[1], n[2]);
      out.col.push(cc[0], cc[1], cc[2]); out.mat.push(S.paint);
    }
    out.idx.push(i, i + 1, i + 2);
  };
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3, col: Vec3, ref: Vec3): void => { tri(a, b, c, col, ref); tri(a, c, d, col, ref); };
  const mid = (a: Vec3, b: Vec3): MVec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const UP: Vec3 = [0, 1, 0];

  // REAR GURNEY: root on the shell at TG, underside root a little further
  // down the back, tip off along the normal and kicked up.
  const TG = 0.30, TU = 0.345, SPAN = 42, NG = 7, H0 = 0.017;
  const gs: { r: MVec3; u: MVec3; n: MVec3; tip: MVec3; c: Vec3 }[] = [];
  for (let i = 0; i < NG; i++) {
    const f = i / (NG - 1) * 2 - 1, az = 180 + f * SPAN, h = H0 * (0.55 + 0.45 * Math.cos(Math.PI * f * 0.92));
    const top = surfAt(TG, az), low = surfAt(TU, az);
    gs.push({ r: top.p, u: low.p, n: top.n, tip: _add(_add(top.p, top.n, h), UP, h * 0.35), c: paint(TG, az) });
  }
  for (let i = 0; i < NG - 1; i++) {
    const a = gs[i]!, b = gs[i + 1]!;
    quad(a.r, b.r, b.tip, a.tip, a.c, _add(a.n, UP, 0.6));                 // the upper face, in paint
    quad(a.u, b.u, b.tip, a.tip, AERO_DARK, [-a.n[0], -1, -a.n[2]]);     // its dark underside
  }
  for (const g of [gs[0]!, gs[NG - 1]!]) {
    const side: Vec3 = [g.r[0], 0, 0];
    tri(g.r, g.tip, g.u, g.c, side);
  }

  // TOP INTAKE on the centreline: front (mouth) to back (faired into the crown).
  const IT = [0.22, 0.17, 0.12, 0.08, 0.05], IH = [0.015, 0.013, 0.009, 0.004, 0], IW = 0.026;
  const st = IT.map((t, i) => {
    const c = surfAt(t, 0), aB = azAtHalfWidth(t, IW), aT = azAtHalfWidth(t, IW * 0.75);
    const sink = (az: number): MVec3 => { const s = surfAt(t, az); return _add(s.p, s.n, -0.004); };
    const lift = (az: number): MVec3 => _add(surfAt(t, az).p, c.n, IH[i]!);
    return { n: c.n, bl: sink(-aB), tl: lift(-aT), tr: lift(aT), br: sink(aB), col: paint(t, 0) };
  });
  for (let i = 0; i < st.length - 1; i++) {
    const a = st[i]!, b = st[i + 1]!;
    quad(a.bl, b.bl, b.tl, a.tl, a.col, [-1, 0.3, 0]);
    quad(a.tl, b.tl, b.tr, a.tr, a.col, a.n);
    quad(a.tr, b.tr, b.br, a.br, a.col, [1, 0.3, 0]);
  }
  const m0 = st[0]!;
  quad(m0.bl, m0.tl, m0.tr, m0.br, AERO_DARK, [0, 0, 1]);   // the mouth, facing forward

  // VISOR STRIP: along the gasket's upper edge (visorAt grown 0.020), from
  // temple to temple. Field and shadow builds drop it: sub-pixel there.
  if (simplePaint) return out;
  const grow = 0.020, t0g = VISOR_T0 - grow, t1g = VISOR_T1 + grow, AZW = (VISOR_AZ + grow * 110) * 1.55;
  const vs: { li: MVec3; lo: MVec3; ho: MVec3; hi: MVec3; n: MVec3 }[] = [];
  for (let az = -70; az <= 70.001; az += 14) {
    const tTop = t0g + (t1g - t0g) * Math.asin(Math.min(1, Math.abs(az) / AZW)) / Math.PI;
    const lo = surfAt(tTop - 0.004, az), hi = surfAt(tTop - 0.064, az);
    vs.push({ li: _add(lo.p, lo.n, -0.001), lo: _add(lo.p, lo.n, 0.0035), ho: _add(hi.p, hi.n, 0.0035), hi: _add(hi.p, hi.n, -0.001), n: mid(lo.n, hi.n) });
  }
  for (let i = 0; i < vs.length - 1; i++) {
    const a = vs[i]!, b = vs[i + 1]!;
    quad(a.lo, b.lo, b.ho, a.ho, AERO_DARK, a.n);
    quad(a.ho, b.ho, b.hi, a.hi, AERO_DARK, [0, 1, 0]);
    quad(a.li, b.li, b.lo, a.lo, AERO_DARK, [0, -1, 0]);
  }
  for (const v of [vs[0]!, vs[vs.length - 1]!]) quad(v.li, v.lo, v.ho, v.hi, AERO_DARK, [v.lo[0], 0, 0]);
  return out;
}

interface Corner { p: MVec3; n: MVec3; t: number; az: number }

/** helmets.js:750-826. The painted shell (plus aero unless S.aero === false) centred at
 *  (cx, cy, cz), cy being the temple line; appended to out. */
function build(out: MeshOut, cx: number, cy: number, cz: number, design: HelmetDesign, S: HelmetBuildOptions): MeshOut {
  // Field cars and depth casters keep the traced shell, smooth normals and visor but
  // skip the artwork: at tens of pixels the zones are sub-pixel.
  const simplePaint = !!(S && S.simplePaint);
  const skin = simplePaint ? null : shell(design);
  const rings = simplePaint ? FIELD_RINGS : RINGS;
  const slices = simplePaint ? FIELD_SLICES : SLICES;
  const meshRingT = (i: number): number => Math.pow(i / rings, 1.25);
  const clamp1 = (c: Vec3): MVec3 => [Math.min(c[0], 1), Math.min(c[1], 1), Math.min(c[2], 1)];
  // (t, azimuth in degrees) -> position, smooth normal, and the pair itself.
  // du/da stay tied to the BASE grid so a split quad's normals match its
  // neighbours' exactly and no subdivision seam can show in the light.
  const du = 0.5 / rings, da = Math.PI / slices;
  const corner = (t: number, az: number): Corner => {
    const a = (az * Math.PI) / 180;
    const p = pointAt(t, a);
    const pu = pointAt(Math.min(1, t + du), a), pd = pointAt(Math.max(0, t - du), a);
    const pr = pointAt(t, a + da), pl = pointAt(t, a - da);
    const tu = [pu[0] - pd[0], pu[1] - pd[1], pu[2] - pd[2]] as const;
    const ta = [pr[0] - pl[0], pr[1] - pl[1], pr[2] - pl[2]] as const;
    let n: MVec3 = [ta[1] * tu[2] - ta[2] * tu[1], ta[2] * tu[0] - ta[0] * tu[2], ta[0] * tu[1] - ta[1] * tu[0]];
    const m = Math.hypot(n[0], n[1], n[2]) || 1;
    n = [n[0] / m, n[1] / m, n[2] / m];
    if (t <= 0) n = [0, 1, 0];                         // the pole, where both tangents vanish
    return { p, n, t, az };
  };
  const sample = simplePaint
    ? (t: number, az: number): ShellSample => {
        const glass = isVisor(Math.min(1, t), ((az % 360) + 360) % 360);
        return { c: glass ? design.visor : design.base, glass };
      }
    : (t: number, az: number): ShellSample => skin!(Math.min(1, t), ((az % 360) + 360) % 360);
  // what the paint IS at a point, as a value two samples can be compared on
  const key = (t: number, az: number): string => { const v = sample(t, az);
    return (v.glass ? "g" : "") + v.c.map((x) => Math.round(x * 255)).join(","); };
  // one sample per TRIANGLE, at its centroid: flat paint, mesh-crisp edges
  const paintTri = (v0: Corner, v1: Corner, v2: Corner): { c: MVec3; mat: number } => {
    const v = sample((v0.t + v1.t + v2.t) / 3, (v0.az + v1.az + v2.az) / 3);
    return { c: clamp1(v.c), mat: v.glass ? S.glass : S.paint };
  };
  const emit = (a: Corner, b: Corner, c: Corner): void => {
    const paint = paintTri(a, b, c);
    const i = out.pos.length / 3;
    for (const v of [a, b, c]) {
      out.pos.push(cx + v.p[0], cy + v.p[1], cz + v.p[2]);
      out.nrm.push(v.n[0], v.n[1], v.n[2]);
      out.col.push(paint.c[0], paint.c[1], paint.c[2]);
      out.mat.push(paint.mat);
    }
    out.idx.push(i, i + 1, i + 2);
  };
  // a quad in (t, az), split while its corners disagree about the paint.
  // Shadow casters pass maxSplit: 0 (paint-edge splits are invisible in a depth map).
  const splitCap = (S && typeof S.maxSplit === "number") ? S.maxSplit : MAX_SPLIT;
  const patch = (t0: number, t1: number, a0: number, a1: number, depth: number): void => {
    const tm = (t0 + t1) / 2, am = (a0 + a1) / 2;
    if (depth < splitCap) {
      const k = key(t0, a0);
      if (key(t0, a1) !== k || key(t1, a1) !== k || key(t1, a0) !== k || key(tm, am) !== k) {
        patch(t0, tm, a0, am, depth + 1); patch(t0, tm, am, a1, depth + 1);
        patch(tm, t1, am, a1, depth + 1); patch(tm, t1, a0, am, depth + 1);
        return;
      }
    }
    const a = corner(t0, a0), b = corner(t0, a1), c = corner(t1, a1), d = corner(t1, a0);
    emit(a, b, c); emit(a, c, d);
  };
  for (let r = 0; r < rings; r++)
    for (let sl = 0; sl < slices; sl++)
      patch(meshRingT(r), meshRingT(r + 1), (sl / slices) * 360, ((sl + 1) / slices) * 360, 0);
  // S.aero === false builds the bare traced shell (the shape tests measure it).
  if (!(S && S.aero === false)) buildAero(out, cx, cy, cz, design, S, simplePaint);
  return out;
}

/** helmets.js:828-831. Shallow-frozen like the original (Object.freeze(Helmets)). */
export const Helmets = Object.freeze({
  DESIGNS, COLORS: C, designFor, painter, shell, isVisor, generated, keyNum, ZONES, SHAPE, pointAt, build, buildAero, surfAt,
  RINGS, SLICES, FIELD_RINGS, FIELD_SLICES, ringT, MAX_SPLIT,   // the tessellation, so previews/tests can name both detail levels
});
export type HelmetsApi = typeof Helmets;
