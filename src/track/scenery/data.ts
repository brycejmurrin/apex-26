/**
 * The GENERIC scenery data tables: named colour packs, theme fallbacks,
 * crowd/window tints, sign segments and stand liveries. Pure constants.
 *
 * Port of f1-game js/track/scenery/data.js:1-209 (`TrackSceneryData`),
 * verbatim; only types and `export` added. resolveCityStyle reads THEME_DEF
 * (declared below it) at call time, as in f1-game.
 */
import type { AtmPack, AtmPackName, RVec3 } from "../../contracts/scenery";

/** `def.furniture` / FURN_DEF row (data.js:62-69). */
export interface FurnitureRow {
  readonly tree: string;
  readonly fol: RVec3;
  readonly lamp: string;
  readonly lc?: RVec3;
  readonly sparse?: boolean;
  readonly treeCrown?: string;
}

/** `def.kit` / KIT_DEF row (data.js:96-102): every family optional. */
export interface KitRow {
  readonly marshal?: string;
  readonly rail?: string;
  readonly fence?: string;
  readonly tyre?: string;
  readonly board?: string;
  readonly gantry?: string;
  readonly camera?: string;
  readonly hoarding?: string;
}

/** A resolved city style (THEME_DEF row, data.js:126-133). */
export interface CityStyle {
  readonly neon: readonly RVec3[];
  readonly bias: number;
  readonly fh: readonly number[];
  readonly bh: readonly number[];
  readonly kinds: readonly string[];
  readonly neonKinds: readonly string[];
  readonly tone: { readonly n: RVec3; readonly d: RVec3 } | null;
  readonly dayPal: readonly RVec3[];
  readonly [extra: string]: unknown;
}

/** `def.cityStyle` as authored: neon / dayPal are NAMES into NC / DC. */
export interface CityStyleRaw {
  readonly neon?: readonly string[];
  readonly dayPal?: readonly string[];
  readonly [extra: string]: unknown;
}

/** STAND_LIVERIES row (data.js:180-200). */
export interface StandLivery {
  readonly shell: RVec3;
  readonly roof: RVec3;
  readonly fascia: RVec3;
  readonly crowd: RVec3;
}

export const NC = {
  mag: [0.95, 0.15, 0.55], cyan: [0.18, 0.85, 0.98], gold: [1.00, 0.78, 0.12],
  violet: [0.62, 0.22, 1.0], blue: [0.22, 0.48, 1.0], orange: [1.00, 0.42, 0.08],
  red: [1.0, 0.16, 0.22], teal: [0.0, 0.92, 0.78], white: [0.86, 0.92, 1.0],
  green: [0.25, 1.0, 0.45], pink: [1.0, 0.30, 0.62], lime: [0.66, 1.0, 0.22],
  ice: [0.55, 0.82, 1.0], yellow: [1.0, 0.92, 0.25], purple: [0.82, 0.30, 0.96],
  rose: [1.0, 0.45, 0.55], amber: [1.00, 0.55, 0.12],
} satisfies { readonly [name: string]: RVec3 };

export const DC = {
  cream:   [0.86, 0.82, 0.72], sand:    [0.80, 0.71, 0.54], tan:     [0.74, 0.63, 0.47],
  stone:   [0.78, 0.76, 0.70], terra:   [0.74, 0.46, 0.34], brick:   [0.62, 0.40, 0.34],
  ochre:   [0.82, 0.63, 0.36], white:   [0.88, 0.88, 0.85], greyblue:[0.56, 0.62, 0.70],
  slate:   [0.48, 0.53, 0.60], paleblue:[0.66, 0.74, 0.83], teal:    [0.54, 0.70, 0.68],
  peach:   [0.92, 0.74, 0.61], pink:    [0.90, 0.69, 0.74], mint:    [0.72, 0.86, 0.77],
  aqua:    [0.62, 0.82, 0.84], lemon:   [0.92, 0.87, 0.62], coral:   [0.88, 0.55, 0.46],
  // darker greys + cool glass + muted metals for modern downtown cores
  concrete:[0.52, 0.53, 0.55], charcoal:[0.34, 0.36, 0.41], graphite:[0.27, 0.29, 0.34],
  steel:   [0.45, 0.50, 0.57], darkglass:[0.26, 0.34, 0.45], bluglass:[0.34, 0.44, 0.58],
  bronze:  [0.55, 0.45, 0.33], gold:    [0.72, 0.58, 0.30], copper:  [0.62, 0.42, 0.30],
} satisfies { readonly [name: string]: RVec3 };

export const BLD: readonly string[] = ["setback", "tiered", "podium", "slab", "twin", "jenga", "cylinder", "spire", "dome", "chevron", "notch", "fin", "antenna", "cross", "arch", "ziggurat", "drum", "hall"];

export const CROWD_DAY: readonly RVec3[] = [
  [0.82, 0.82, 0.84], [0.74, 0.72, 0.68], [0.30, 0.34, 0.52], [0.20, 0.24, 0.34],
  [0.78, 0.20, 0.20], [0.86, 0.52, 0.16], [0.90, 0.82, 0.28], [0.24, 0.48, 0.28],
  [0.20, 0.44, 0.66], [0.66, 0.24, 0.42], [0.52, 0.54, 0.58], [0.90, 0.90, 0.92],
  [0.40, 0.26, 0.18], [0.14, 0.16, 0.20], [0.86, 0.40, 0.46], [0.30, 0.62, 0.60],
];

export const WINTINTS: readonly RVec3[] = [
  [0.98, 0.86, 0.56], [0.92, 0.82, 0.60],   // warm office
  [0.62, 0.76, 1.00], [0.72, 0.84, 0.98],   // cool glass
  [1.00, 0.70, 0.85], [0.70, 0.95, 0.90],   // soft accents
];

export const HOUSE_WALLS: readonly RVec3[] = [[0.86, 0.80, 0.68], [0.80, 0.62, 0.46], [0.74, 0.72, 0.70], [0.70, 0.50, 0.38]];

export const HOUSE_ROOFS: readonly RVec3[] = [[0.42, 0.20, 0.14], [0.32, 0.32, 0.35], [0.36, 0.24, 0.16]];

export const MOTORHOME_BODY: readonly RVec3[] = [[0.90, 0.90, 0.92], [0.85, 0.86, 0.90], [0.94, 0.92, 0.86]];

export const SIGN_SEG: { readonly [seg: string]: readonly [number, number, number, number] } = {
  top: [0.16, 0.84, 0.86, 1.00], mid: [0.16, 0.84, 0.44, 0.58], bottom: [0.16, 0.84, 0.00, 0.14],
  topL: [0.04, 0.20, 0.50, 0.94], topR: [0.80, 0.96, 0.50, 0.94],
  botL: [0.04, 0.20, 0.06, 0.50], botR: [0.80, 0.96, 0.06, 0.50],
};

export const SIGN_DIGIT: { readonly [digit: number]: readonly string[] } = {
  0: ["top", "topL", "topR", "botL", "botR", "bottom"], 1: ["topR", "botR"],
  2: ["top", "topR", "mid", "botL", "bottom"], 3: ["top", "topR", "mid", "botR", "bottom"],
  4: ["topL", "topR", "mid", "botR"], 5: ["top", "topL", "mid", "botR", "bottom"],
  6: ["top", "topL", "mid", "botL", "botR", "bottom"], 7: ["top", "topR", "botR"],
  8: ["top", "topL", "topR", "mid", "botL", "botR", "bottom"], 9: ["top", "topL", "topR", "mid", "botR", "bottom"],
};


// Roadside planting + lighting. Every circuit — city, desert AND forest/green
// — authors its own `furniture` row in js/circuits/<id>.js so no two tracks
// share trees and lamps: { tree: palm|broad|fir|cypress|stonePine|
// broadleafFall|acacia|plane, fol: [r,g,b], lamp: arm|globe|post|none,
// lc?: [r,g,b], sparse?: true, treeCrown?: vase|columnar|weeping }. The
// resolution in buildProps is def.furniture || FURN_DEF[theme] || FURN_DEF.green.
// Trees/lamps never call blockAt and respect onTrack(), so they add depth
// without touching the driving boundary.
export const FURN_DEF: { readonly [theme: string]: FurnitureRow } = {
  green:        { tree: "broad", fol: [0.26, 0.42, 0.20], lamp: "none" },
  desert:       { tree: "palm",  fol: [0.28, 0.40, 0.18], lamp: "arm",   lc: [1.0, 0.80, 0.45] },
  street_night: { tree: "broad", fol: [0.22, 0.40, 0.20], lamp: "arm",   lc: [0.90, 0.95, 1.0] },
  street_day:   { tree: "broad", fol: [0.28, 0.44, 0.22], lamp: "globe", lc: [1.0, 0.90, 0.70] },
  modern:       { tree: "broad", fol: [0.26, 0.42, 0.20], lamp: "post",  lc: [0.95, 0.95, 1.0] },
};

// `furniture` keys a circuit's planting and lighting; `kit` keys its barriers,
// signage and marshal kit. Same rule, same fallback shape (api.kitOf):
//   def.kit || KIT_DEF[theme] || KIT_DEF.green
// and every field is optional — an absent field falls back to that emitter's
// own default, which is its pre-existing geometry.
//
// Why this table exists: marshalPost, billboard, fence, guardrail, tyreWall,
// gantry, cameraTower and sponsorHoarding were ~870 calls of geometry that
// was byte-identical on all 40 circuits, differing only in tint. They line
// the whole lap and are in frame constantly, so they were the single largest
// reason different circuits read as the same place — far more than the
// grandstands, which are already well parameterised.
//
// BUDGET: tyre "double"/"pyramid" multiply the tyre count and fence
// "hoarding"/"palisade" are heavier than mesh. They appear only on circuits
// with measured headroom, never in KIT_DEF. Families: marshal, rail, fence,
// tyre, board, gantry, camera, hoarding (each circuit's `kit` row lists them).
export const KIT_DEF: { readonly [theme: string]: KitRow } = {
  green:        { marshal: "hut", rail: "armco", fence: "mesh", tyre: "stack", board: "panel", gantry: "box", camera: "lattice", hoarding: "panel" },
  desert:       { marshal: "hut", rail: "armco", fence: "mesh", tyre: "stack", board: "panel", gantry: "box", camera: "lattice", hoarding: "panel" },
  street_night: { marshal: "hut", rail: "armco", fence: "mesh", tyre: "stack", board: "panel", gantry: "box", camera: "lattice", hoarding: "panel" },
  street_day:   { marshal: "hut", rail: "armco", fence: "mesh", tyre: "stack", board: "panel", gantry: "box", camera: "lattice", hoarding: "panel" },
  modern:       { marshal: "hut", rail: "armco", fence: "mesh", tyre: "stack", board: "panel", gantry: "box", camera: "lattice", hoarding: "panel" },
};

// City generator style. Each street/modern circuit authors `cityStyle` in
// js/circuits/<id>.js with neon / dayPal as NAMES into NC / DC (circuit files
// load before this one, so they cannot reference the arrays); buildProps
// resolves the names here, then falls back to THEME_DEF[theme]. Unknown
// names are dropped so a typo narrows the palette instead of throwing.
// MERGE, DO NOT REPLACE. buildProps reads seven fields off the result
// (neonKinds.length, kinds.length, fh[0], bh[0], bias, neon[i], dayPal[i]);
// `resolveCityStyle(x) || THEME_DEF[theme]` was all-or-nothing, so a row that
// omitted any one of them threw inside Tracks.build (or, for an empty neon
// list, took `i % 0` = NaN into the colour lookup) for that circuit alone.
// The theme row is the base; the circuit's row overrides field by field, and
// an empty resolved palette keeps the theme's.
export function resolveCityStyle(raw: CityStyleRaw | null | undefined, theme: string | undefined): CityStyle | null {
  if (!raw) return null;
  const base = (theme !== undefined ? THEME_DEF[theme] : undefined) || (THEME_DEF["modern"] as CityStyle);
  const pick = (names: readonly string[] | undefined, table: { readonly [name: string]: RVec3 }, dflt: readonly RVec3[]): readonly RVec3[] => {
    const out = (names || []).map((n) => table[n]).filter((c): c is RVec3 => Boolean(c));
    return out.length ? out : dflt;
  };
  return Object.assign({}, base, raw, { neon: pick(raw.neon, NC, base.neon), dayPal: pick(raw.dayPal, DC, base.dayPal) });
}

export const THEME_DEF: { readonly [theme: string]: CityStyle } = {
  street_night: { neon: [NC.mag, NC.cyan, NC.gold, NC.violet, NC.teal], bias: 0.5, fh: [16, 48], bh: [34, 80], kinds: BLD, neonKinds: ["screen", "clad"], tone: null,
                  dayPal: [DC.stone, DC.greyblue, DC.cream, DC.tan, DC.slate, DC.paleblue, DC.sand] },
  street_day:   { neon: [NC.gold, NC.teal, NC.white, NC.rose], bias: 0.16, fh: [9, 19], bh: [14, 30], kinds: ["setback", "slab", "podium", "tiered"], neonKinds: [], tone: { n: [0.22, 0.19, 0.15], d: [0.82, 0.77, 0.66] },
                  dayPal: [DC.cream, DC.sand, DC.tan, DC.stone, DC.ochre, DC.terra, DC.peach] },
  modern:       { neon: [NC.cyan, NC.blue, NC.white, NC.violet, NC.teal], bias: 0.3, fh: [14, 40], bh: [30, 74], kinds: ["setback", "slab", "cylinder", "podium", "spire", "fin", "antenna", "dome"], neonKinds: ["clad", "antenna"], tone: { n: [0.16, 0.16, 0.18], d: [0.62, 0.62, 0.66] },
                  dayPal: [DC.white, DC.paleblue, DC.greyblue, DC.slate, DC.stone, DC.teal, DC.cream] },
};

export const ATM: { readonly [P in AtmPackName]: AtmPack } = {
  coolNight: {
    zenith: [0.02, 0.03, 0.08], horizon: [0.06, 0.08, 0.14], fog: [0.05, 0.06, 0.10],
    fogDensity: 0.0026, ambientSky: [0.48, 0.54, 0.68], ambientGround: [0.28, 0.28, 0.32],
    sunColor: [0.55, 0.60, 0.72], grass: [0.10, 0.12, 0.11], runoff: [0.22, 0.22, 0.24],
  },
  warmNight: {
    zenith: [0.08, 0.04, 0.10], horizon: [0.22, 0.10, 0.18], fog: [0.14, 0.08, 0.12],
    fogDensity: 0.0024, ambientSky: [0.58, 0.42, 0.52], ambientGround: [0.40, 0.30, 0.28],
    sunColor: [0.85, 0.55, 0.40], grass: [0.14, 0.14, 0.12], runoff: [0.28, 0.24, 0.22],
  },
  dampArdennes: {
    zenith: [0.42, 0.48, 0.52], horizon: [0.58, 0.62, 0.64], fog: [0.55, 0.60, 0.62],
    fogDensity: 0.0032, ambientSky: [0.50, 0.54, 0.58], ambientGround: [0.28, 0.30, 0.26],
    // Mown-grass verge (Spa survey 2026-10-10) — was bare-earth tan 0.40/0.38/0.34.
    sunColor: [0.88, 0.90, 0.92], grass: [0.14, 0.28, 0.16], runoff: [0.20, 0.30, 0.16],
  },
  britishOvercast: {
    zenith: [0.55, 0.62, 0.72], horizon: [0.72, 0.76, 0.82], fog: [0.68, 0.72, 0.78],
    fogDensity: 0.0020, ambientSky: [0.58, 0.62, 0.70], ambientGround: [0.30, 0.34, 0.28],
    sunColor: [0.92, 0.94, 0.96], grass: [0.16, 0.40, 0.18], runoff: [0.48, 0.46, 0.42],
  },
  dustyBowl: {
    zenith: [0.55, 0.62, 0.78], horizon: [0.78, 0.72, 0.58], fog: [0.72, 0.68, 0.55],
    fogDensity: 0.0022, ambientSky: [0.62, 0.58, 0.50], ambientGround: [0.40, 0.36, 0.28],
    sunColor: [1.0, 0.94, 0.78], grass: [0.42, 0.40, 0.22], runoff: [0.58, 0.50, 0.34],
  },
  alpineGreen: {
    zenith: [0.22, 0.48, 0.82], horizon: [0.55, 0.72, 0.88], fog: [0.58, 0.72, 0.82],
    fogDensity: 0.0016, ambientSky: [0.48, 0.58, 0.72], ambientGround: [0.24, 0.32, 0.22],
    sunColor: [1.0, 0.96, 0.88], grass: [0.12, 0.42, 0.18], runoff: [0.40, 0.42, 0.32],
  },
  rivieraDay: {
    zenith: [0.20, 0.48, 0.88], horizon: [0.70, 0.82, 0.92], fog: [0.72, 0.82, 0.90],
    fogDensity: 0.0014, ambientSky: [0.55, 0.62, 0.78], ambientGround: [0.36, 0.34, 0.28],
    sunColor: [1.0, 0.96, 0.88], grass: [0.22, 0.42, 0.20], runoff: [0.55, 0.52, 0.46],
  },
};

export const COL: { readonly aquaRunoff: RVec3; readonly basinTeal: RVec3; readonly desertSand: RVec3 } = {
  aquaRunoff:  [0.12, 0.72, 0.78],   // Miami Dolphins apron
  basinTeal:   [0.08, 0.55, 0.62],   // Montreal Olympic Basin / river
  desertSand:  [0.72, 0.58, 0.38],   // warm tan runoff sandwich
};

export const STAND_LIVERIES: { readonly [family: string]: StandLivery } = {
  // Permanent-circuit steel and concrete
  steel:     { shell: [0.40, 0.41, 0.46], roof: [0.86, 0.88, 0.92], fascia: [0.44, 0.45, 0.50], crowd: [0.72, 0.40, 0.32] },
  darkSteel: { shell: [0.24, 0.26, 0.31], roof: [0.52, 0.55, 0.60], fascia: [0.28, 0.30, 0.35], crowd: [0.68, 0.36, 0.30] },
  concrete:  { shell: [0.58, 0.58, 0.56], roof: [0.78, 0.78, 0.76], fascia: [0.62, 0.62, 0.60], crowd: [0.66, 0.42, 0.34] },
  // Bare aluminium bleachers — uncovered temporary seating
  alu:       { shell: [0.74, 0.75, 0.78], roof: [0.88, 0.89, 0.92], fascia: [0.70, 0.71, 0.74], crowd: [0.62, 0.44, 0.38] },
  scaffold:  { shell: [0.50, 0.52, 0.56], roof: [0.68, 0.70, 0.74], fascia: [0.46, 0.48, 0.52], crowd: [0.60, 0.40, 0.36] },
  // Warm/regional families
  sandstone: { shell: [0.72, 0.64, 0.50], roof: [0.88, 0.84, 0.74], fascia: [0.68, 0.60, 0.47], crowd: [0.70, 0.46, 0.28] },
  terracotta:{ shell: [0.62, 0.40, 0.32], roof: [0.84, 0.78, 0.70], fascia: [0.58, 0.37, 0.30], crowd: [0.74, 0.38, 0.26] },
  pastel:    { shell: [0.80, 0.78, 0.82], roof: [0.92, 0.90, 0.94], fascia: [0.76, 0.74, 0.78], crowd: [0.58, 0.48, 0.62] },
  // Saturated / branded
  crimson:   { shell: [0.52, 0.12, 0.16], roof: [0.86, 0.86, 0.88], fascia: [0.46, 0.11, 0.14], crowd: [0.80, 0.24, 0.20] },
  navy:      { shell: [0.16, 0.22, 0.38], roof: [0.80, 0.83, 0.90], fascia: [0.15, 0.20, 0.34], crowd: [0.36, 0.44, 0.72] },
  teal:      { shell: [0.16, 0.38, 0.40], roof: [0.82, 0.88, 0.88], fascia: [0.15, 0.34, 0.36], crowd: [0.30, 0.62, 0.60] },
  orange:    { shell: [0.68, 0.34, 0.08], roof: [0.90, 0.88, 0.84], fascia: [0.62, 0.31, 0.07], crowd: [0.92, 0.52, 0.10] },
};

// Each circuit's `standSet` (js/circuits/<id>.js) names the families its
// grandstands rotate through, so a venue's stands differ from each other
// while staying recognisably one place; this is the permanent-circuit default.
export const STAND_SET_DEF: readonly string[] = ["steel", "darkSteel", "concrete"];

// Regulation Grand Prix distance (km): the fewest laps past `default`, except
// the circuit(s) listed by id. tracks.js derives every def's gpLaps from it.
export const GP_DISTANCE_KM: { readonly default: number; readonly [id: string]: number } = { default: 305, monaco: 260 };
