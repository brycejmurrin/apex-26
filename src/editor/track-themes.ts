/**
 * TrackThemes: the custom track designer's THEME PRESETS. Ported verbatim from
 * f1-game js/editor/track-themes.js (TrackThemes IIFE, :1-942).
 *
 * A preset is the bundle of def fields a shipped circuit authors by hand (theme,
 * palette, terrain, furniture, stands, city style, pit mode) plus a GENERATED
 * `scenery(api)` closure that adds what the engine's generic dressing does not
 * (horizon, forest belts, stands at the slow corners, water, flood masts). Every
 * colour comes from the packs src/track/scenery/data.ts already ships (ATM / COL),
 * so a custom circuit reads as one of the game's own looks. Pure data + one
 * factory; no DOM.
 *
 * Port notes:
 * - f1-game's `Log.warn` / `Log.info` calls (sceneryFor, :916, :924, :933, :936)
 *   are dropped; the try/catch structure that guarded them stays.
 * - The lazy globals `TrackPit` (survey, :496) and `TrackDesignerProps`
 *   (sceneryFor, :930) are ES imports here, so their `typeof X !== "undefined"`
 *   guards fold to "always present".
 * - `api.track.curv` / `api.curv` (survey, :458) are not in the SceneryApi
 *   contract; they are read through a narrow local cast. TODO(lane-scenery).
 * - `addFrustum(..., null)` (buttes, :880-883) passes `null` for the basis, which
 *   the contract types as `basis?: Basis`; read through a narrow local cast.
 *   TODO(lane-scenery).
 * - `!` non-null assertions and `as` casts are type-only; no runtime change.
 */
import type {
  AtmPack, Basis, RVec3, SceneryApi, SceneryBuffer, SceneryTrack,
} from "../contracts/scenery";
import { ATM, COL } from "../track/scenery/data";
import { resolve as resolvePit, type PitDefLike } from "../track/core/pit";
import { unit } from "./hash32";
import { dress as dressProps } from "./props";

// ── Types ───────────────────────────────────────────────────────────────────

/** A preset's (or a def's) palette overrides. Keys as track-themes.js:24-320 author them. */
export interface ThemePal {
  zenith?: RVec3;
  horizon?: RVec3;
  fog?: RVec3;
  fogDensity?: number;
  ambientSky?: RVec3;
  ambientGround?: RVec3;
  sunColor?: RVec3;
  sun?: RVec3;
  sunDir?: RVec3;
  grass?: RVec3;
  runoff?: RVec3;
}

/** A preset's `furniture` row. track-themes.js:31 et seq. */
export interface ThemeFurniture {
  tree: string;
  fol: RVec3;
  lamp: string;
  lc?: RVec3;
  sparse?: boolean;
  treeCrown?: string;
}

/** A preset's `cityStyle` (names into data.ts NC / DC). track-themes.js:71 */
export interface ThemeCityStyle {
  neon: string[];
  dayPal?: string[];
  bias: number;
}

/** One theme preset. track-themes.js:24 */
export interface ThemePreset {
  label: string;
  blurb: string;
  swatch: string[];
  theme: string;
  sceneryTheme: string;
  night: boolean;
  street: boolean;
  pal: ThemePal;
  dayPal?: ThemePal;
  terrainOuter: number;
  flatTerrain: boolean;
  elevStyle: string;
  terrainMat?: string;
  baseHW?: number;
  furniture: ThemeFurniture;
  standSet: string[];
  pit?: { mode: string };
  cityStyle?: ThemeCityStyle;
  cityM?: number;
}

/** The scenery options, by name. track-themes.js:367 */
export interface ThemeLook {
  time: "auto" | "day" | "dusk" | "night";
  trees: "normal" | "few" | "many";
  crowd: "normal" | "few" | "packed";
}

/**
 * The fields of a designer `design` record this module reads (custom-tracks.js
 * sanitize builds the full record). `look` and `props` are sanitized on read.
 */
export interface ThemeDesign {
  theme?: string;
  seed?: number;
  lengthM?: number;
  /** Control polygon: [x, z, ...] per point. */
  pts?: ReadonlyArray<readonly number[]>;
  look?: unknown;
  props?: unknown;
}

/** One `dressingExclusions` window from cityGaps. track-themes.js:358 */
export interface CityGap {
  kind: "city";
  s0: number;
  s1: number;
}

/** The def fields defFields hands to custom-tracks. track-themes.js:414 */
export interface ThemeDefFields {
  theme: string;
  sceneryTheme: string;
  night: boolean;
  street: boolean;
  pal: ThemePal;
  terrainOuter: number;
  flatTerrain: boolean;
  furniture: ThemeFurniture;
  standSet: string[];
  cityStyle?: ThemeCityStyle;
  pit?: { mode: string };
  terrainMat?: string;
  dressingExclusions?: CityGap[];
}

/** A straight from survey(). track-themes.js:472 */
export interface SurveyStraight {
  s0: number;
  s1: number;
  lenM: number;
  k0: number;
  k1: number;
}

/** A slow-corner peak from survey(). track-themes.js:480 */
export interface SurveyPeak {
  k: number;
  v: number;
  left: boolean;
}

/** survey()'s result; sceneryFor adds `look`. track-themes.js:497 */
export interface ThemeSurvey {
  n: number;
  total: number;
  ds: number;
  straights: SurveyStraight[];
  slow: SurveyPeak[];
  outward: (k: number) => 1 | -1;
  far: number;
  cx: number;
  cz: number;
  radius: number;
  pitSide: number;
  K: number;
  look?: ThemeLook;
}

/** The design-seeded hash a dresser draws from. track-themes.js:913 */
export type ThemeHash = (tag: string, i?: number) => number;

/** A named dresser. track-themes.js:654 */
export type ThemeDresser = [string, (api: SceneryApi, sv: ThemeSurvey, h: ThemeHash) => void];

// Picker / share-code order. The share code (codec) stores the INDEX into this
// list, so append only: never reorder or remove.
/** track-themes.js:15 */
export const ORDER: readonly string[] = ["parkland", "alpine", "oasis", "desertnight", "harbour", "marina", "tilke", "autumn",
  "tuscany", "coast", "savanna", "ardennes", "airfield", "canyon", "winter", "twilight",
  "jungle", "lakeside", "moorland", "metropolis",
  // Slice I: append only; share-code indexes the first twenty unchanged.
  "shipyard", "saltflat", "vineyard", "stadium", "island", "blossom", "volcanic", "fjord", "badlands", "redwood"];

const pal = (base?: ThemePal | AtmPack | null, extra?: ThemePal | null): ThemePal => Object.assign({}, base || {}, extra || {});
const rgb = (c: RVec3, m: number): RVec3 => [c[0] * m, c[1] * m, c[2] * m];

/** track-themes.js:24 */
export const PRESETS: { [id: string]: ThemePreset } = {
  parkland: {
    label: "PARKLAND GP", blurb: "Rolling deep-green grass, broadleaf tree belts, bright noon sun.",
    swatch: ["#2e7d32", "#9ccc65"],
    theme: "green", sceneryTheme: "park", night: false, street: false,
    pal: { grass: [0.20, 0.44, 0.18], sunDir: [0.5, 0.55, 0.3] },
    terrainOuter: 120, flatTerrain: false, elevStyle: "rolling",
    furniture: { tree: "broad", fol: [0.26, 0.42, 0.20], lamp: "none" },
    standSet: ["steel", "darkSteel", "concrete"],
  },
  alpine: {
    label: "ALPINE FOREST", blurb: "Dark pine walls, grey-blue haze, snowy ridges on the horizon.",
    swatch: ["#1b5e20", "#cfd8dc"],
    theme: "green", sceneryTheme: "park", night: false, street: false,
    pal: pal(ATM.alpineGreen),
    terrainOuter: 160, flatTerrain: false, elevStyle: "hilly", terrainMat: "SNOW",
    furniture: { tree: "fir", fol: [0.16, 0.32, 0.18], lamp: "none" },
    standSet: ["darkSteel", "alu", "scaffold"],
  },
  oasis: {
    label: "DESERT OASIS", blurb: "Ochre sand run-off, sparse palms, white-hot sun.",
    swatch: ["#c9a35b", "#f4e3b2"],
    theme: "desert", sceneryTheme: "desert", night: false, street: false,
    pal: pal(ATM.dustyBowl, { runoff: COL.desertSand }),
    terrainOuter: 120, flatTerrain: true, elevStyle: "flat", terrainMat: "SAND",
    furniture: { tree: "palm", fol: [0.28, 0.40, 0.18], lamp: "arm", lc: [1.0, 0.80, 0.45], sparse: true },
    standSet: ["sandstone", "concrete", "alu"],
  },
  desertnight: {
    label: "DESERT NIGHT", blurb: "Floodlit sand, warm amber sky, long shadows.",
    swatch: ["#3e2723", "#ffb74d"],
    theme: "desert", sceneryTheme: "night-event", night: true, street: false,
    pal: pal(ATM.warmNight, { runoff: [0.30, 0.26, 0.20] }),
    dayPal: pal(ATM.dustyBowl, { runoff: COL.desertSand }),
    terrainOuter: 120, flatTerrain: true, elevStyle: "flat", terrainMat: "SAND",
    furniture: { tree: "palm", fol: [0.26, 0.38, 0.18], lamp: "arm", lc: [1.0, 0.82, 0.50], sparse: true },
    standSet: ["sandstone", "darkSteel", "alu"],
  },
  harbour: {
    label: "HARBOUR STREET", blurb: "Concrete walls, pastel façades, a marina beside the track.",
    swatch: ["#ffcc80", "#4fc3f7"],
    theme: "street_day", sceneryTheme: "street", night: false, street: true,
    pal: pal(ATM.rivieraDay),
    terrainOuter: 28, flatTerrain: false, elevStyle: "flat", baseHW: 6.0,
    furniture: { tree: "palm", fol: [0.25, 0.45, 0.22], lamp: "globe", lc: [1.0, 0.92, 0.70] },
    standSet: ["pastel", "scaffold", "alu"],
    pit: { mode: "street" },
    cityStyle: { neon: ["gold", "teal", "white", "rose"], dayPal: ["cream", "sand", "ochre", "terra", "peach"], bias: 0.12 },
    // The day city is the fleet's densest generic dressing (~0.2 M prop
    // vertices per km, un-instanced): full density for this many metres of
    // lap, gaps beyond it (cityGaps): 7 km built 1.36-1.58 M, over the
    // 1.1 M fleet cap; thinned, ≤ 0.91 M.
    cityM: 3600,
  },
  marina: {
    label: "MARINA NIGHT", blurb: "Floodlit walls, neon skyline on dark water.",
    swatch: ["#0d1b2a", "#e040fb"],
    theme: "street_night", sceneryTheme: "night-event", night: true, street: true,
    pal: pal(ATM.coolNight),
    dayPal: pal(ATM.rivieraDay),
    terrainOuter: 36, flatTerrain: false, elevStyle: "flat", baseHW: 6.0,
    furniture: { tree: "palm", fol: [0.22, 0.40, 0.18], lamp: "arm", lc: [0.90, 0.95, 1.0] },
    standSet: ["navy", "darkSteel", "alu"],
    pit: { mode: "street" },
    cityStyle: { neon: ["mag", "cyan", "violet", "teal"], bias: 0.55 },
  },
  tilke: {
    label: "TILKE MODERN", blurb: "Wide painted run-off, sleek stands and a tower, manicured grass.",
    swatch: ["#1e88e5", "#eceff1"],
    theme: "modern", sceneryTheme: "permanent", night: false, street: false,
    pal: { grass: [0.22, 0.44, 0.20], runoff: COL.aquaRunoff },
    terrainOuter: 120, flatTerrain: false, elevStyle: "flat",
    furniture: { tree: "plane", fol: [0.30, 0.46, 0.22], lamp: "post", lc: [0.95, 0.95, 1.0] },
    standSet: ["navy", "teal", "darkSteel"],
  },
  autumn: {
    label: "AUTUMN COUNTRYSIDE", blurb: "Amber trees, golden low sun, mist in the dips.",
    swatch: ["#bf360c", "#ffd54f"],
    theme: "green", sceneryTheme: "park", night: false, street: false,
    pal: { grass: [0.30, 0.38, 0.16], horizon: [0.80, 0.74, 0.62], fog: [0.78, 0.72, 0.62], sunColor: [1.0, 0.86, 0.62], sun: [1.0, 0.88, 0.60] },
    terrainOuter: 140, flatTerrain: false, elevStyle: "rolling",
    furniture: { tree: "broadleafFall", fol: [0.62, 0.34, 0.12], lamp: "none" },
    standSet: ["concrete", "terracotta", "steel"],
  },
  tuscany: {
    label: "TUSCAN HILLS", blurb: "Golden grass, cypress rows, terracotta stands on warm rolling hills.",
    swatch: ["#c0a040", "#5d6b2f"],
    theme: "green", sceneryTheme: "park", night: false, street: false,
    pal: { grass: [0.40, 0.42, 0.18], runoff: [0.62, 0.50, 0.32], zenith: [0.26, 0.46, 0.80], horizon: [0.86, 0.78, 0.60], fog: [0.84, 0.76, 0.60], sunColor: [1.0, 0.90, 0.70], sun: [1.0, 0.92, 0.72] },
    terrainOuter: 150, flatTerrain: false, elevStyle: "rolling",
    furniture: { tree: "cypress", fol: [0.16, 0.28, 0.14], lamp: "none", treeCrown: "columnar" },
    standSet: ["terracotta", "sandstone", "concrete"],
  },
  coast: {
    label: "CLIFFTOP COAST", blurb: "Umbrella pines above a blue sea, headlands on the horizon.",
    swatch: ["#2e6b3a", "#1e88e5"],
    theme: "green", sceneryTheme: "park", night: false, street: false,
    pal: pal(ATM.rivieraDay, { grass: [0.24, 0.40, 0.18] }),
    terrainOuter: 120, flatTerrain: false, elevStyle: "rolling",
    furniture: { tree: "stonePine", fol: [0.20, 0.36, 0.16], lamp: "none" },
    standSet: ["sandstone", "alu", "pastel"],
  },
  savanna: {
    label: "SAVANNA PLAINS", blurb: "Golden grassland, flat-topped acacias, far blue mesas.",
    swatch: ["#c8a050", "#8d6e3f"],
    theme: "desert", sceneryTheme: "desert", night: false, street: false,
    pal: pal(ATM.dustyBowl, { grass: [0.56, 0.48, 0.24], runoff: [0.62, 0.40, 0.24], horizon: [0.88, 0.74, 0.52], sunColor: [1.0, 0.86, 0.62] }),
    terrainOuter: 130, flatTerrain: false, elevStyle: "rolling",
    furniture: { tree: "acacia", fol: [0.34, 0.40, 0.16], lamp: "none", sparse: true },
    standSet: ["orange", "sandstone", "alu"],
  },
  ardennes: {
    label: "MISTY FOREST", blurb: "Damp grey sky, deep pine valleys, forested ridges in the mist.",
    swatch: ["#26402c", "#90a4ae"],
    theme: "green", sceneryTheme: "park", night: false, street: false,
    pal: pal(ATM.dampArdennes),
    terrainOuter: 160, flatTerrain: false, elevStyle: "hilly",
    furniture: { tree: "fir", fol: [0.14, 0.28, 0.16], lamp: "none" },
    standSet: ["darkSteel", "steel", "crimson"],
  },
  airfield: {
    label: "AIRFIELD", blurb: "Flat old runways under an overcast sky, hangars and windbreaks.",
    swatch: ["#4f7a3a", "#b0bec5"],
    theme: "green", sceneryTheme: "permanent", night: false, street: false,
    pal: pal(ATM.britishOvercast),
    terrainOuter: 120, flatTerrain: true, elevStyle: "flat",
    furniture: { tree: "broad", fol: [0.22, 0.38, 0.18], lamp: "none", sparse: true },
    standSet: ["steel", "alu", "scaffold"],
  },
  canyon: {
    label: "RED ROCK CANYON", blurb: "Rust-red ground, scrub trees, towering sandstone buttes.",
    swatch: ["#b5532e", "#f0a868"],
    theme: "desert", sceneryTheme: "desert", night: false, street: false,
    pal: pal(ATM.dustyBowl, { grass: [0.62, 0.32, 0.18], runoff: [0.66, 0.42, 0.26], horizon: [0.92, 0.70, 0.52], fog: [0.86, 0.64, 0.48], zenith: [0.24, 0.46, 0.82] }),
    terrainOuter: 130, flatTerrain: false, elevStyle: "rolling",
    furniture: { tree: "acacia", fol: [0.36, 0.38, 0.18], lamp: "none", sparse: true },
    standSet: ["terracotta", "orange", "sandstone"],
  },
  winter: {
    label: "WINTER SNOW", blurb: "Snow to the horizon, dark firs, white peaks under a cold sun.",
    swatch: ["#eceff1", "#1b3a2a"],
    theme: "green", sceneryTheme: "park", night: false, street: false,
    pal: { zenith: [0.30, 0.48, 0.78], horizon: [0.80, 0.86, 0.94], fog: [0.84, 0.88, 0.94], fogDensity: 0.0018, grass: [0.86, 0.88, 0.92], runoff: [0.70, 0.72, 0.76],
      sunColor: [1.0, 0.97, 0.92], ambientSky: [0.62, 0.68, 0.80], ambientGround: [0.52, 0.54, 0.58], sunDir: [0.5, 0.4, 0.3] },
    terrainOuter: 160, flatTerrain: false, elevStyle: "hilly", terrainMat: "SNOW",
    furniture: { tree: "fir", fol: [0.12, 0.24, 0.16], lamp: "none" },
    standSet: ["darkSteel", "crimson", "alu"],
  },
  twilight: {
    label: "TWILIGHT RESORT", blurb: "Purple dusk sky, a floodlit lagoon, a hotel over the start.",
    swatch: ["#4a2a5e", "#ff8a65"],
    theme: "modern", sceneryTheme: "night-event", night: true, street: false,
    pal: { zenith: [0.10, 0.08, 0.22], horizon: [0.52, 0.26, 0.30], fog: [0.30, 0.18, 0.24], fogDensity: 0.0020, ambientSky: [0.60, 0.48, 0.62], ambientGround: [0.40, 0.32, 0.34],
      sunColor: [0.95, 0.55, 0.40], grass: [0.14, 0.18, 0.14], runoff: [0.08, 0.40, 0.44] },
    dayPal: { grass: [0.22, 0.44, 0.20], runoff: COL.aquaRunoff },
    terrainOuter: 120, flatTerrain: true, elevStyle: "flat",
    furniture: { tree: "palm", fol: [0.20, 0.36, 0.18], lamp: "post", lc: [0.95, 0.90, 1.0] },
    standSet: ["navy", "teal", "alu"],
  },
  jungle: {
    label: "RAINFOREST", blurb: "Steaming green hills, palm walls, emerald peaks in the haze.",
    swatch: ["#1b5e20", "#a5d6a7"],
    theme: "green", sceneryTheme: "park", night: false, street: false,
    pal: { grass: [0.16, 0.42, 0.16], zenith: [0.30, 0.50, 0.74], horizon: [0.74, 0.82, 0.78], fog: [0.70, 0.80, 0.74], fogDensity: 0.0016,
      sunColor: [1.0, 0.96, 0.84], ambientSky: [0.58, 0.68, 0.62], ambientGround: [0.30, 0.36, 0.26] },
    terrainOuter: 150, flatTerrain: false, elevStyle: "hilly",
    furniture: { tree: "palm", fol: [0.16, 0.40, 0.16], lamp: "none" },
    standSet: ["teal", "steel", "concrete"],
  },
  lakeside: {
    label: "NORDIC LAKES", blurb: "Fir forest down to a cold blue lake, red timber houses on the shore.",
    swatch: ["#1565c0", "#2e5d3a"],
    theme: "green", sceneryTheme: "park", night: false, street: false,
    pal: pal(ATM.alpineGreen, { grass: [0.24, 0.42, 0.20] }),
    terrainOuter: 140, flatTerrain: false, elevStyle: "rolling",
    furniture: { tree: "fir", fol: [0.16, 0.32, 0.18], lamp: "none" },
    standSet: ["crimson", "steel", "alu"],
  },
  moorland: {
    label: "HIGHLAND MOOR", blurb: "Heather ridges, grey stone cottages, low cloud over open moor.",
    swatch: ["#6d5a7a", "#7b8a5a"],
    theme: "green", sceneryTheme: "park", night: false, street: false,
    pal: pal(ATM.britishOvercast, { grass: [0.34, 0.38, 0.20] }),
    terrainOuter: 150, flatTerrain: false, elevStyle: "hilly",
    furniture: { tree: "broad", fol: [0.24, 0.34, 0.18], lamp: "none", sparse: true },
    standSet: ["steel", "concrete", "navy"],
  },
  metropolis: {
    label: "METROPOLIS", blurb: "Glass towers, concrete walls, a downtown street circuit at noon.",
    swatch: ["#455a64", "#80d8ff"],
    theme: "street_day", sceneryTheme: "street", night: false, street: true,
    pal: { grass: [0.26, 0.40, 0.22], zenith: [0.28, 0.48, 0.80], horizon: [0.78, 0.82, 0.86], fog: [0.76, 0.80, 0.84] },
    terrainOuter: 28, flatTerrain: false, elevStyle: "flat", baseHW: 6.0,
    furniture: { tree: "plane", fol: [0.26, 0.42, 0.20], lamp: "post", lc: [0.95, 0.95, 1.0] },
    standSet: ["steel", "alu", "scaffold"],
    pit: { mode: "street" },
    cityStyle: { neon: ["white", "cyan", "blue"], dayPal: ["steel", "bluglass", "concrete", "greyblue", "paleblue"], bias: 0.2 },
    cityM: 3600,   // the harbour preset's street budget (see there)
  },
  shipyard: {
    label: "INDUSTRIAL DOCKS", blurb: "Concrete quays, cranes on the horizon, grey water under an overcast sky.",
    swatch: ["#607d8b", "#90a4ae"],
    theme: "modern", sceneryTheme: "permanent", night: false, street: false,
    pal: pal(ATM.britishOvercast, { grass: [0.28, 0.34, 0.28], runoff: [0.48, 0.50, 0.52], horizon: [0.68, 0.72, 0.76], fog: [0.64, 0.68, 0.72], fogDensity: 0.0022 }),
    terrainOuter: 80, flatTerrain: true, elevStyle: "flat",
    furniture: { tree: "plane", fol: [0.22, 0.32, 0.20], lamp: "none", sparse: true },
    standSet: ["steel", "concrete", "scaffold"],
  },
  saltflat: {
    label: "SALT FLATS", blurb: "Blinding white ground, sparse scrub, hard noon sun on a flat plain.",
    swatch: ["#fafafa", "#c9a35b"],
    theme: "desert", sceneryTheme: "desert", night: false, street: false,
    pal: pal(ATM.dustyBowl, {
      grass: [0.92, 0.93, 0.94], runoff: [0.88, 0.86, 0.80], zenith: [0.35, 0.55, 0.88],
      horizon: [0.90, 0.88, 0.82], fog: [0.88, 0.86, 0.80], fogDensity: 0.0012,
      sunColor: [1.0, 0.98, 0.92], sun: [1.0, 0.98, 0.94], sunDir: [0.35, 0.75, 0.25],
      ambientSky: [0.72, 0.74, 0.80], ambientGround: [0.70, 0.68, 0.62],
    }),
    terrainOuter: 140, flatTerrain: true, elevStyle: "flat", terrainMat: "SAND",
    furniture: { tree: "acacia", fol: [0.40, 0.42, 0.22], lamp: "none", sparse: true },
    standSet: ["alu", "sandstone", "steel"],
  },
  vineyard: {
    label: "VINEYARD VALLEY", blurb: "Terraced golden rows, olive and cypress belts, warm afternoon sun.",
    swatch: ["#c9a227", "#6b7c3a"],
    theme: "green", sceneryTheme: "park", night: false, street: false,
    // Distinct from tuscany: cooler olive foliage, brighter gold grass, lower warm sun.
    pal: { grass: [0.48, 0.46, 0.18], runoff: [0.58, 0.48, 0.30], zenith: [0.30, 0.48, 0.78],
      horizon: [0.90, 0.78, 0.52], fog: [0.86, 0.76, 0.56], fogDensity: 0.0015,
      sunColor: [1.0, 0.84, 0.58], sun: [1.0, 0.86, 0.60], sunDir: [0.75, 0.28, 0.35],
      ambientSky: [0.62, 0.56, 0.48], ambientGround: [0.40, 0.36, 0.24] },
    terrainOuter: 150, flatTerrain: false, elevStyle: "rolling",
    furniture: { tree: "cypress", fol: [0.22, 0.34, 0.16], lamp: "none", treeCrown: "columnar" },
    standSet: ["sandstone", "terracotta", "concrete"],
  },
  stadium: {
    label: "STADIUM NIGHT", blurb: "Floodlit bowl, dark sky, dense steel stands packed around the lap.",
    swatch: ["#0d1117", "#ffeb3b"],
    theme: "modern", sceneryTheme: "night-event", night: true, street: false,
    pal: pal(ATM.coolNight, { grass: [0.10, 0.14, 0.12], runoff: [0.20, 0.22, 0.24], sunColor: [0.70, 0.75, 0.90] }),
    dayPal: { grass: [0.22, 0.40, 0.20], runoff: COL.aquaRunoff, zenith: [0.28, 0.48, 0.80], horizon: [0.76, 0.80, 0.86] },
    terrainOuter: 60, flatTerrain: true, elevStyle: "flat",
    furniture: { tree: "plane", fol: [0.20, 0.34, 0.18], lamp: "post", lc: [0.95, 0.95, 1.0], sparse: true },
    standSet: ["steel", "darkSteel", "alu"],
  },
  island: {
    label: "TROPICAL ISLAND", blurb: "Turquoise water, palms, bright sand run-off, humid haze on the lagoon.",
    swatch: ["#26c6da", "#ffe082"],
    theme: "green", sceneryTheme: "park", night: false, street: false,
    pal: pal(ATM.rivieraDay, {
      grass: [0.28, 0.48, 0.22], runoff: [0.86, 0.78, 0.52],
      zenith: [0.22, 0.52, 0.86], horizon: [0.70, 0.86, 0.90], fog: [0.68, 0.84, 0.86], fogDensity: 0.0018,
      sunColor: [1.0, 0.96, 0.86], ambientSky: [0.58, 0.70, 0.78], ambientGround: [0.42, 0.40, 0.30],
    }),
    terrainOuter: 120, flatTerrain: false, elevStyle: "rolling", terrainMat: "SAND",
    furniture: { tree: "palm", fol: [0.18, 0.42, 0.18], lamp: "none" },
    standSet: ["pastel", "sandstone", "teal"],
  },
};

// Append-only additions reuse the established terrain and foliage machinery.
PRESETS.blossom = {
  label: "BLOSSOM PARK", blurb: "Pink blossom belts, fresh spring grass, pale hills and pastel stands.",
  swatch: ["#dc8ca9", "#83a95b"], theme: "green", sceneryTheme: "park", night: false, street: false,
  pal: { grass: [0.30, 0.48, 0.22], runoff: [0.68, 0.62, 0.50], zenith: [0.34, 0.56, 0.84], horizon: [0.90, 0.80, 0.84], fog: [0.86, 0.80, 0.82], sunColor: [1.0, 0.94, 0.86] },
  terrainOuter: 140, flatTerrain: false, elevStyle: "rolling",
  furniture: { tree: "broad", fol: [0.74, 0.40, 0.52], lamp: "none" }, standSet: ["pastel", "alu", "concrete"],
};
PRESETS.volcanic = {
  label: "VOLCANIC COAST", blurb: "Basalt mountains, sparse scrub, a deep-blue shoreline and silver stands.",
  swatch: ["#42454b", "#326580"], theme: "green", sceneryTheme: "park", night: false, street: false,
  pal: { grass: [0.24, 0.27, 0.22], runoff: [0.34, 0.34, 0.36], zenith: [0.24, 0.42, 0.64], horizon: [0.62, 0.70, 0.76], fog: [0.56, 0.64, 0.70], sunColor: [0.96, 0.94, 0.90] },
  terrainOuter: 150, flatTerrain: false, elevStyle: "hilly",
  furniture: { tree: "acacia", fol: [0.28, 0.34, 0.20], lamp: "none", sparse: true }, standSet: ["alu", "darkSteel", "concrete"],
};

PRESETS.fjord = {
  label: "NORDIC FJORD", blurb: "Cold blue water beneath snowy granite mountains, dark conifers and silver stands.",
  swatch: ["#326b88", "#dce8eb"], theme: "green", sceneryTheme: "park", night: false, street: false,
  pal: pal(ATM.alpineGreen, { grass: [0.22, 0.36, 0.28], runoff: [0.48, 0.52, 0.50], horizon: [0.72, 0.82, 0.88], fog: [0.68, 0.78, 0.84] }),
  terrainOuter: 160, flatTerrain: false, elevStyle: "hilly",
  furniture: { tree: "fir", fol: [0.14, 0.28, 0.24], lamp: "none" }, standSet: ["alu", "darkSteel", "concrete"],
};
PRESETS.badlands = {
  label: "RED ROCK BADLANDS", blurb: "Rust-red buttes, sandstone ridges, dry scrub and warm desert sunlight.",
  swatch: ["#a65438", "#d6af72"], theme: "desert", sceneryTheme: "desert", night: false, street: false,
  pal: pal(ATM.dustyBowl, { grass: [0.52, 0.32, 0.20], runoff: [0.68, 0.42, 0.28], horizon: [0.88, 0.70, 0.52], fog: [0.82, 0.64, 0.48] }),
  terrainOuter: 150, flatTerrain: true, elevStyle: "rolling", terrainMat: "SAND",
  furniture: { tree: "acacia", fol: [0.36, 0.38, 0.20], lamp: "none", sparse: true }, standSet: ["sandstone", "terracotta", "concrete"],
};
PRESETS.redwood = {
  label: "REDWOOD VALLEY", blurb: "Towering evergreen forest, fern-green hills, timber cottages and soft coastal haze.",
  swatch: ["#234d38", "#997452"], theme: "green", sceneryTheme: "park", night: false, street: false,
  pal: pal(ATM.alpineGreen, { grass: [0.20, 0.34, 0.18], runoff: [0.48, 0.42, 0.30], horizon: [0.76, 0.82, 0.74], fog: [0.68, 0.76, 0.68] }),
  terrainOuter: 150, flatTerrain: false, elevStyle: "rolling",
  furniture: { tree: "fir", fol: [0.16, 0.32, 0.22], lamp: "none" }, standSet: ["darkSteel", "concrete", "steel"],
};

const clone = <T>(v: T): T => (v == null ? v : JSON.parse(JSON.stringify(v)) as T);

/** track-themes.js:324 */
export function has(id: unknown): boolean { return Object.prototype.hasOwnProperty.call(PRESETS, id as PropertyKey); }
/** The preset, or parkland for an id this build does not know (an older or
 *  newer share code): the circuit still builds, in the default look. track-themes.js:327 */
export function get(id: unknown): ThemePreset { return PRESETS[has(id) ? id as string : ORDER[0]!]!; }

/** Dual-colour LOOK preview CSS from a preset's existing `swatch` pair; the
 *  same 135° split the team picker uses. track-themes.js:332 */
export function swatchCss(id: unknown): string {
  const p = get(id);
  const a = (Array.isArray(p.swatch) && p.swatch[0]) || "#555555";
  const b = (Array.isArray(p.swatch) && p.swatch[1]) || a;
  return "linear-gradient(135deg," + a + " 50%," + b + " 50%)";
}

/** A design's lap length (m): its stored lengthM, else the control polygon. track-themes.js:340 */
export function lapM(design: ThemeDesign | null | undefined): number {
  if (!design) return 0;
  if (Number.isFinite(design.lengthM) && design.lengthM! > 0) return design.lengthM!;
  const pts = Array.isArray(design.pts) ? design.pts : [];
  let L = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; if (a && b) L += Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!); }
  return Number.isFinite(L) ? L : 0;
}
/** The generic city pass plants a block every 18 m whatever the lap length, so a
 *  long street lap outgrows the prop budget. Past `cityM` metres, five evenly
 *  spread `dressingExclusions` windows (kind "city", both sides, centred at 0.1,
 *  0.3 … 0.9, clear of the pit straight at 0) drop the surplus: the city keeps
 *  cityM / L of the lap, at full density where it stands. Lap fractions in the
 *  racing frame. track-themes.js:354 */
export function cityGaps(L: number, cityM: number): CityGap[] | null {
  if (!(cityM > 0) || !(L > cityM)) return null;
  const m = 5, w = (1 - cityM / L) / m;
  const out: CityGap[] = [];
  for (let i = 0; i < m; i++) { const c = (i + 0.5) / m; out.push({ kind: "city", s0: +(c - w / 2).toFixed(4), s1: +(c + w / 2).toFixed(4) }); }
  return out;
}

// ── SCENERY OPTIONS: per-design knobs on top of the preset ──────────────────
// Each is an index into its list and index 0 means "as the theme has it", so a
// design that never touched them stores, encodes (codec FLAG.look), ids
// (custom-tracks canonical) and builds exactly as before. The share code stores
// the INDEXES: append only.
/** track-themes.js:367 */
export const LOOK = Object.freeze({
  time: Object.freeze(["auto", "day", "dusk", "night"] as const),
  trees: Object.freeze(["normal", "few", "many"] as const),
  crowd: Object.freeze(["normal", "few", "packed"] as const),
});
type LookKey = keyof typeof LOOK;
/** A stored / decoded look → { time, trees, crowd } names, or null when every
 *  knob is at its default (nothing to store). Unknown names fall to default. track-themes.js:374 */
export function sanitizeLook(raw: unknown): ThemeLook | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { readonly [key: string]: unknown };
  const out = {} as { [K in LookKey]: string };
  let any = false;
  for (const k of Object.keys(LOOK) as LookKey[]) {
    const list: readonly string[] = LOOK[k];
    const v = list.includes(r[k] as string) ? r[k] as string : list[0]!;
    out[k] = v; if (v !== list[0]) any = true;
  }
  return any ? out as ThemeLook : null;
}
/** The design's look with every knob filled in (defaults where absent). track-themes.js:385 */
export function lookOf(design: ThemeDesign | null | undefined): ThemeLook {
  return sanitizeLook(design && design.look) || { time: LOOK.time[0], trees: LOOK.trees[0], crowd: LOOK.crowd[0] };
}
/** DUSK: the preset's day palette under a low, warm sun. track-themes.js:389 */
function duskPal(base: ThemePal): ThemePal {
  const g = base.grass || [0.18, 0.42, 0.16];
  return Object.assign({}, base, {
    zenith: [0.20, 0.22, 0.42], horizon: [0.92, 0.58, 0.38], fog: [0.80, 0.56, 0.42], fogDensity: 0.0020,
    sun: [1.0, 0.66, 0.38], sunColor: [1.0, 0.62, 0.34], sunDir: [0.8, 0.16, 0.3],
    ambientSky: [0.50, 0.44, 0.52], ambientGround: [0.30, 0.24, 0.20], grass: rgb(g, 0.85),
  } satisfies ThemePal);
}
/** NIGHT on a day preset: its grass and run-off dimmed under the fleet's night sky. track-themes.js:398 */
function nightPalFor(p: ThemePreset): ThemePal {
  const base = p.pal || {};
  return pal(p.theme === "desert" ? ATM.warmNight : ATM.coolNight, {
    grass: rgb(base.grass || [0.18, 0.42, 0.16], 0.45), runoff: rgb(base.runoff || [0.55, 0.42, 0.28], 0.5),
  });
}
const STREET_THEME = { day: "street_day", night: "street_night" };
const DAY_CITY_M = 3600;   // harbour's cityM: the day city's budget-safe length

/** The def fields a design inherits from its theme: what custom-tracks spreads
 *  into the raw def before TrackDef.fromRaw copies them onto the LIST entry.
 *  `design` (optional) scales the length-dependent ones (cityGaps) and carries
 *  the scenery options (look: TIME OF DAY here; TREES / CROWD in sceneryFor).
 *  track-themes.js:411 */
export function defFields(id: unknown, design?: ThemeDesign | null): ThemeDefFields {
  const p = get(id);
  const look = lookOf(design);
  const out: ThemeDefFields = {
    theme: p.theme, sceneryTheme: p.sceneryTheme, night: !!p.night, street: !!p.street,
    pal: clone(p.pal), terrainOuter: p.terrainOuter, flatTerrain: !!p.flatTerrain,
    furniture: clone(p.furniture), standSet: clone(p.standSet),
  };
  const dayBase = p.night ? (p.dayPal || {}) : p.pal;
  if (look.time === "day" && p.night) { out.night = false; out.pal = clone(dayBase); }
  else if (look.time === "dusk") { out.night = false; out.pal = clone(duskPal(dayBase)); }
  else if (look.time === "night" && !p.night) {
    out.night = true; out.pal = clone(nightPalFor(p));
    // Lights along the lap: the theme's lamp, or a plain post where it has none.
    if (out.furniture.lamp === "none") Object.assign(out.furniture, { lamp: "post", lc: [1.0, 0.92, 0.78] });
  }
  if (out.street) out.theme = STREET_THEME[out.night ? "night" : "day"];
  if (look.trees === "few") out.furniture.sparse = true;
  if (p.cityStyle) out.cityStyle = clone(p.cityStyle);
  if (p.pit) out.pit = clone(p.pit);
  if (p.terrainMat) out.terrainMat = p.terrainMat;   // "SAND" / "SNOW": the ground beyond the verge (track/core/mesh)
  // A night street preset run by DAY gets the day city, and its thinning.
  const gaps = design ? cityGaps(lapM(design), p.cityM || (out.theme === "street_day" ? DAY_CITY_M : 0)) : null;
  if (gaps) out.dressingExclusions = gaps;
  return out;
}

// ── The generated scenery(api) closure ──────────────────────────────────────
// The engine's generic passes already give a custom circuit its barriers, kit,
// roadside trees, marshals, pit complex and (street/modern) city blocks. What
// they do not make is everything beyond the ribbon: a horizon, forest belts,
// grandstands where the action is, water, flood masts. Each preset gets those
// here, seeded from the design (Hash32.unit: api.hash is only node-seeded). Every
// placement stays inside the api's own guards and inside the fleet prop budget
// at the validator's 7 km lap cap: belts cover at most `coverage` of BELT_REF_M,
// the horizon is a FIXED ring of at most 28 pieces beyond lapBounds().radius,
// the street city thins past cityM (cityGaps) and the flood ring spaces itself
// to the lamp budget (floods).
const BELT_REF_M = 5000, LAMP_BUDGET = 460;

/** The members survey() reads that SceneryApi lacks. TODO(lane-scenery): add
 *  `curv` to SceneryTrack (f1-game track.curv, tracks.js:161) or the api. */
type SurveyApi = SceneryApi & {
  readonly curv?: ArrayLike<number>;
  readonly track: SceneryTrack & { readonly curv: ArrayLike<number> };
};

/** Build-time reads of the centreline the dressers share. track-themes.js:457 */
export function survey(api: SceneryApi): ThemeSurvey {
  const { track, n, px, pz, curv } = Object.assign({ curv: (api as SurveyApi).track.curv }, api as SurveyApi);
  const total = track.total, ds = total / n;
  const K = 0.0035;   // TrackPit.PIT_K: "not actively cornering"
  // Straights: runs of |k| ≤ K, longest first, as lap fractions. ONE lap,
  // starting at the first curved node: a scan from node 0 counted the start
  // straight twice, and belts() then planted the pit straight twice.
  const straights: SurveyStraight[] = [];
  let c0 = 0;
  while (c0 < n && Math.abs(curv[c0]!) <= K) c0++;
  let run = 0, start = 0;
  if (c0 < n) for (let i = c0; i <= c0 + n; i++) {
    const k = i % n;
    if (i < c0 + n && Math.abs(curv[k]!) <= K) { if (!run) start = k; run++; }
    else { if (run >= 50) straights.push({ s0: start / n, s1: ((start + run) % n) / n, lenM: run * ds, k0: start, k1: (start + run) % n }); run = 0; }
  }
  straights.sort((a, b) => b.lenM - a.lenM);
  const uniq = straights.slice(0, 6);
  // Slow corners: top |k| peaks ≥ 250 m from the start line and 300 m apart.
  const peaks: SurveyPeak[] = [];
  for (let k = 0; k < n; k++) {
    const v = Math.abs(curv[k]!);
    if (v > 0.004 && v >= Math.abs(curv[(k - 1 + n) % n]!) && v > Math.abs(curv[(k + 1) % n]!)) peaks.push({ k, v, left: curv[k]! > 0 });
  }
  peaks.sort((a, b) => b.v - a.v);
  const slow: SurveyPeak[] = [];
  for (const p of peaks) {
    const sM = p.k * ds, fromStart = Math.min(sM, total - sM);
    if (fromStart < 250) continue;
    if (slow.some((q) => { let d = Math.abs(q.k - p.k) * ds; d = Math.min(d, total - d); return d < 300; })) continue;
    slow.push(p); if (slow.length >= 3) break;
  }
  // Outward side at a node: the right vector's component away from the centroid.
  const { cx, cz, radius } = api.lapBounds();
  const outward = (k: number): 1 | -1 => ((px[k]! - cx) * track.rx[k]! + (pz[k]! - cz) * track.rz[k]!) >= 0 ? 1 : -1;
  // The farthest node from the centroid (where a shoreline reads best).
  let far = 0, fd = -1;
  for (let k = 0; k < n; k += 4) { const d = Math.hypot(px[k]! - cx, pz[k]! - cz); if (d > fd) { fd = d; far = k; } }
  // f1-game guards a lazy global (`typeof TrackPit !== "undefined" && TrackPit.resolve`); imported here.
  const pitSide = resolvePit(api.def as PitDefLike).side;
  return { n, total, ds, straights: uniq, slow, outward, far, cx, cz, radius, pitSide, K };
}

interface StandOpts {
  tiers?: number; h?: number; hills?: number; second?: boolean; stand?: boolean;
  livery?: string; livery2?: string; grass?: RVec3; riser?: RVec3;
}
interface BeltOpts {
  coverage?: number; gap?: number; col?: RVec3; col2?: RVec3; pineFrac?: number;
  hMin?: number; hMax?: number; density?: number; second?: boolean;
}
interface HorizonOpts {
  count?: number; rMin?: number; rMax?: number; mountain?: boolean;
  w0?: number; w1?: number; h0?: number; h1?: number; rough?: number; snowline?: number;
  snow?: RVec3; rock?: RVec3; forest?: RVec3; len?: number; wid?: number; cols?: RVec3[];
}
interface ShoreOpts { gap?: number; size?: RVec3; col?: RVec3; second?: boolean }
interface FloodOpts { dist?: number; h?: number; cool?: boolean }
interface OasisOpts { col?: RVec3 }
interface TracksideOpts { street?: boolean }
interface VillageOpts {
  count?: number; gap?: number; w?: number; h?: number; d?: number;
  walls?: RVec3[]; roof?: RVec3; roofType?: string;
}
interface PaddockOpts { count?: number }
interface FunfairOpts { dist?: number; r?: number }
interface ButteOpts { count?: number; rMin?: number; rMax?: number }

/** CROWD: FEW keeps one single-tier stand and at most one bank; PACKED adds a
 *  tier (≤ 3), the second stand, a bank at every slow corner and a stand at the
 *  slowest. A street preset (hills 0) stays off the kerbside. track-themes.js:503 */
function crowdOpts(look: ThemeLook | undefined, opts: StandOpts): StandOpts {
  const c = look ? look.crowd : "normal";
  if (c === "few") return Object.assign({}, opts, { tiers: 1, second: false, stand: false, hills: Math.min(1, opts.hills != null ? opts.hills : 3) });
  if (c === "packed") return Object.assign({}, opts, { tiers: Math.min(3, (opts.tiers || 1) + 1), second: true, stand: opts.hills !== 0, hills: opts.hills === 0 ? 0 : 3 });
  return opts;
}
/** TREES: FEW plants 40 % of the belts; MANY 160 % (≤ 80 % of BELT_REF_M) and a second, taller row. track-themes.js:510 */
function treeOpts(look: ThemeLook | undefined, opts: BeltOpts): BeltOpts {
  const t = look ? look.trees : "normal", cov = opts.coverage || 0.35;
  if (t === "few") return Object.assign({}, opts, { coverage: cov * 0.4, second: false });
  if (t === "many") return Object.assign({}, opts, { coverage: Math.min(0.8, cov * 1.6), second: true });
  return opts;
}
/** Grandstands on the pit straight (opposite the pit complex) + banks at the slow corners. track-themes.js:517 */
function stands(api: SceneryApi, sv: ThemeSurvey, h: ThemeHash, opts: StandOpts): void {
  opts = crowdOpts(sv.look, opts);
  const { grandstandEx, spectatorHill } = api;
  const side = -sv.pitSide, L = sv.total;
  const startLen = Math.min(140, Math.max(60, sv.straights.length ? sv.straights[0]!.lenM * 0.25 : 90));
  grandstandEx(0.0, side, 18, startLen, null, null, { tiers: opts.tiers || 1, h: opts.h || 12, livery: opts.livery });
  if (opts.second !== false) grandstandEx((startLen + 40) / L, side, 18, Math.round(startLen * 0.7), null, null, { tiers: 1, h: 10, livery: opts.livery2 || opts.livery });
  sv.slow.slice(0, opts.hills != null ? opts.hills : 3).forEach((p, i) => {
    const f = p.k / sv.n, out = p.left ? 1 : -1;   // +k = LEFT turn: the outside of the bend is the right-hand side
    const half = 0.011 + h("hill", i) * 0.006;
    if (opts.stand && i === 0) grandstandEx(f, out, 20, 90, null, null, { tiers: 1, h: 11, livery: opts.livery });
    else spectatorHill(f - half, f + half, out, 24 + h("hillGap", i) * 8, { rows: 4 + Math.round(h("rows", i) * 2), density: 0.4 + h("dens", i) * 0.2, grass: opts.grass, riser: opts.riser });
  });
}
/** Forest belts along the longest straights (and a sprinkling of corners), ≤ coverage of the lap. track-themes.js:532 */
function belts(api: SceneryApi, sv: ThemeSurvey, h: ThemeHash, opts: BeltOpts): void {
  opts = treeOpts(sv.look, opts);
  const { forestEdge } = api;
  let covered = 0;
  const budget = (opts.coverage || 0.35) * Math.min(sv.total, BELT_REF_M);
  const spans = sv.straights.map((s) => ({ s0: s.s0, s1: s.s1, lenM: s.lenM }));
  // Both sides of the longest straight, then alternate sides.
  spans.forEach((sp, i) => {
    if (covered >= budget) return;
    const sides = i === 0 ? [-1, 1] : [h("beltSide", i) < 0.5 ? -1 : 1];
    for (const side of sides) {
      if (covered >= budget) break;
      const gap = (opts.gap || 30) + h("beltGap", i * 2 + side) * 14;
      forestEdge(sp.s0, sp.s1, side, gap, { hMin: opts.hMin || 9, hMax: opts.hMax || 17, col: opts.col, col2: opts.col2, pineFrac: opts.pineFrac != null ? opts.pineFrac : 0.4, density: opts.density || 0.35 });
      if (opts.second) forestEdge(sp.s0, sp.s1, side, gap + 36, { hMin: (opts.hMin || 9) + 3, hMax: (opts.hMax || 17) + 5, col: opts.col2, col2: opts.col, pineFrac: opts.pineFrac != null ? opts.pineFrac : 0.4, density: 0.2 });
      covered += sp.lenM;
    }
  });
}
/** A ring of low ridges (or mountains) beyond the lap's reach. track-themes.js:552 */
function horizon(api: SceneryApi, sv: ThemeSurvey, h: ThemeHash, opts: HorizonOpts): void {
  const { ridge, mountain, pyMin } = api;
  const count = Math.min(28, opts.count || 24), r0 = sv.radius + (opts.rMin || 150), r1 = sv.radius + (opts.rMax || 260);
  for (let i = 0; i < count; i++) {
    const a = (i + (h("ringA", i) - 0.5) * 0.6) / count * Math.PI * 2;
    const rr = r0 + h("ringR", i) * (r1 - r0);
    const x = sv.cx + Math.cos(a) * rr, z = sv.cz + Math.sin(a) * rr;
    if (opts.mountain) {
      const w = (opts.w0 || 700) + h("ringW", i) * (opts.w1 || 400), hh = (opts.h0 || 260) + h("ringH", i) * (opts.h1 || 160);
      mountain(x, z, pyMin - 16, w, hh, { seg: 10 + Math.round(h("ringSeg", i) * 4), seed: 3 + i * 5, rough: opts.rough != null ? opts.rough : 0.3,
        snowline: opts.snowline != null ? opts.snowline : 1.6, snow: opts.snow, rock: opts.rock || [0.33, 0.32, 0.36], forest: opts.forest || [0.14, 0.24, 0.20] });
    } else {
      const len = (opts.len || 160) + h("ringL", i) * 80, w = (opts.wid || 36) + h("ringWd", i) * 14, hh = (opts.h0 || 10) + h("ringH", i) * (opts.h1 || 8);
      const col: RVec3 = opts.cols ? opts.cols[i % opts.cols.length]! : [0.22, 0.42, 0.20];
      ridge(x, z, pyMin, a + Math.PI / 2 + (h("ringT", i) - 0.5) * 0.5, len, w, hh, col);
    }
  }
}
/** Water on the outward side of the farthest node (a coast, a lake), plus a second sheet ≥ ¼ lap away. track-themes.js:571 */
function shore(api: SceneryApi, sv: ThemeSurvey, h: ThemeHash, opts: ShoreOpts): void {
  const { waterSurface, K } = api;
  const n = sv.n;
  const place = (k: number, tag: string) => waterSurface(k, sv.outward(k), opts.gap || 30, opts.size || [700, 0.2, 900], opts.col || [0.18, 0.38, 0.56], { id: "custom-water-" + tag });
  place(sv.far, "a");
  if (opts.second !== false) place(K(((sv.far / n) + 0.25 + h("shore", 1) * 0.5) % 1), "b");
}
/** Flood masts both sides every `step` m. The lamp register also holds the
 *  generic lamp posts (one per ~22 m, ~L / 20 with the pit's), so the ring takes
 *  what LAMP_BUDGET leaves: every 60 m up to ~5.5 km, sparser beyond, ≤ 460
 *  lamps in all at 7 km (MAST_LAMP_CAP 512). track-themes.js:583 */
function floods(api: SceneryApi, sv: ThemeSurvey, h: ThemeHash, opts: FloodOpts): void {
  const room = Math.max(40, LAMP_BUDGET - sv.total / 20);
  const step = Math.max(60, (2 * sv.total) / room);
  api.floodMastRing(step, { dist: opts.dist || 28, h: opts.h || 26, cool: opts.cool !== false, pool: true });
}
/** track-themes.js:588 */
function oasis(api: SceneryApi, sv: ThemeSurvey, h: ThemeHash, opts: OasisOpts): void {
  // One pool on the inside of the lap, where there is most room; false when the footprint is rejected.
  const inside = -sv.outward(sv.far);
  api.waterSurface(sv.far, inside, 60, [140, 0.3, 90], opts.col || [0.16, 0.42, 0.48], { id: "custom-oasis" });
}

/** THE TRACKSIDE KIT every theme shares: TV camera towers on the outside of the
 *  two slowest corners, a sponsor board in each slow corner's braking zone, a run
 *  of hoardings along the second straight and the TV compound behind the pits.
 *  Each emitter is the api's own, with its own onTrack / solid guards. track-themes.js:599 */
const BOARD_COLS: RVec3[] = [[0.86, 0.12, 0.10], [0.10, 0.28, 0.66], [0.96, 0.78, 0.10], [0.10, 0.52, 0.30], [0.92, 0.92, 0.92]];
function trackside(api: SceneryApi, sv: ThemeSurvey, h: ThemeHash, opts?: TracksideOpts): void {
  opts = opts || {};
  const { cameraTower, billboard, sponsorHoarding, broadcastCompound, K } = api;
  sv.slow.slice(0, 2).forEach((p, i) => {
    if (cameraTower) cameraTower(p.k, p.left ? 1 : -1, 22 + Math.round(h("camGap", i) * 6), { h: 14 + Math.round(h("camH", i) * 4) });
  });
  if (billboard) sv.slow.forEach((p, i) => {
    const kb = (p.k - Math.round(120 / sv.ds) + sv.n) % sv.n;   // ~120 m before the apex: the braking zone
    billboard(kb, p.left ? 1 : -1, 9, 12, 4.5, BOARD_COLS[Math.floor(h("board", i) * BOARD_COLS.length) % BOARD_COLS.length]!);
  });
  const st = sv.straights[1];
  if (sponsorHoarding && st && !opts.street && st.s1 > st.s0) {
    const s1 = Math.min(st.s1 - 0.004, st.s0 + 0.004 + 220 / sv.total);
    if (s1 > st.s0 + 0.01) sponsorHoarding(st.s0 + 0.004, s1, sv.outward(st.k0), 9, {});
  }
  if (broadcastCompound && K) broadcastCompound(K(0.935), sv.pitSide, 76, { vans: 2 + Math.round(h("vans", 0)), dishes: 2, mastH: 9 });
}
/** A VILLAGE (or a cluster of chalets): two staggered rows of houses on the
 *  outside of a mid straight, set back past the forest belts (gap ≥ 95 m). track-themes.js:619 */
function village(api: SceneryApi, sv: ThemeSurvey, h: ThemeHash, opts?: VillageOpts): void {
  opts = opts || {};
  const { house, K } = api;
  const st = sv.straights[2] || sv.straights[1];
  if (!house || !K || !st) return;
  const span = (st.s1 - st.s0 + 1) % 1, side = sv.outward(st.k0), n = opts.count || 8;
  for (let i = 0; i < n; i++) {
    const f = (st.s0 + span * (0.15 + 0.7 * i / Math.max(1, n - 1))) % 1;
    house(K(f), side, (opts.gap || 95) + (i % 2) * 20 + h("vGap", i) * 8,
      (opts.w || 8) + h("vW", i) * 4, (opts.h || 5) + h("vH", i) * 3, (opts.d || 9) + h("vD", i) * 4,
      { wall: opts.walls ? opts.walls[i % opts.walls.length] : undefined, roof: opts.roof, roofType: opts.roofType });
  }
}
/** THE PADDOCK: a row of team motorhomes behind the pit building. track-themes.js:633 */
function paddock(api: SceneryApi, sv: ThemeSurvey, h: ThemeHash, opts?: PaddockOpts): void {
  opts = opts || {};
  const { motorhome, K } = api;
  if (!motorhome || !K) return;
  const n = opts.count || 6;
  const wall: RVec3[] = [[0.86, 0.87, 0.90], [0.18, 0.20, 0.24], [0.78, 0.10, 0.10], [0.10, 0.24, 0.56]];
  for (let i = 0; i < n; i++) {
    motorhome(K((0.975 + i * 0.006) % 1), sv.pitSide, 70 + (i % 2) * 20, 12, 7 + h("mhH", i) * 2, 14,
      { wall: wall[Math.floor(h("mhC", i) * wall.length) % wall.length], window: [0.18, 0.22, 0.28] });
  }
}
/** A FUNFAIR wheel on the outside of the second straight, well back. track-themes.js:645 */
function funfair(api: SceneryApi, sv: ThemeSurvey, h: ThemeHash, opts?: FunfairOpts): void {
  const st = sv.straights[1] || sv.straights[0];
  if (!api.ferrisWheel || !api.K || !st) return;
  const span = (st.s1 - st.s0 + 1) % 1;
  api.ferrisWheel(api.K((st.s0 + span * 0.5) % 1), sv.outward(st.k0), (opts && opts.dist) || 130, (opts && opts.r) || 26);
}

// Each preset is a list of independent DRESSERS: one that throws is skipped,
// and the rest still stand (sceneryFor).
/** track-themes.js:654 */
export const DRESS: { [id: string]: ThemeDresser[] } = {
  parkland: [
    ["belts", (api, sv, h) => belts(api, sv, h, { coverage: 0.35, gap: 40, col: [0.20, 0.40, 0.18], col2: [0.26, 0.42, 0.20], pineFrac: 0.2, hMin: 9, hMax: 16 })],
    ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 2, h: 13 })],
    ["horizon", (api, sv, h) => horizon(api, sv, h, { count: 24, h0: 10, h1: 6, cols: [[0.22, 0.42, 0.20], [0.20, 0.38, 0.18]] })],
    ["village", (api, sv, h) => village(api, sv, h, { count: 8 })],
    ["paddock", (api, sv, h) => paddock(api, sv, h)],
  ],
  alpine: [
    ["belts", (api, sv, h) => belts(api, sv, h, { coverage: 0.5, gap: 30, col: [0.12, 0.28, 0.14], col2: [0.16, 0.32, 0.18], pineFrac: 0.85, hMin: 14, hMax: 24, density: 0.3, second: true })],
    ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 1, h: 11, hills: 2, second: false })],
    ["horizon", (api, sv, h) => horizon(api, sv, h, { mountain: true, count: 12, rMin: 900, rMax: 1500, w0: 700, w1: 400, h0: 260, h1: 160, rough: 0.3, snowline: 0.55, snow: [0.95, 0.96, 1.0], rock: [0.33, 0.32, 0.36], forest: [0.14, 0.24, 0.20] })],
    ["chalets", (api, sv, h) => village(api, sv, h, { count: 7, walls: [[0.46, 0.32, 0.20], [0.40, 0.28, 0.18]], roof: [0.30, 0.30, 0.34], roofType: "gable", h: 6 })],
  ],
  oasis: [
    ["horizon", (api, sv, h) => horizon(api, sv, h, { count: 28, rMin: 180, rMax: 320, len: 200, wid: 46, h0: 14, h1: 14, cols: [[0.74, 0.60, 0.40], [0.70, 0.56, 0.38]] })],
    ["oasis", (api, sv, h) => oasis(api, sv, h, {})],
    ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 1, h: 12, hills: 1, grass: [0.62, 0.52, 0.34] })],
  ],
  desertnight: [
    ["horizon", (api, sv, h) => horizon(api, sv, h, { count: 28, rMin: 180, rMax: 320, len: 200, wid: 46, h0: 14, h1: 14, cols: [[0.36, 0.30, 0.22], [0.32, 0.27, 0.20]] })],
    ["oasis", (api, sv, h) => oasis(api, sv, h, { col: [0.06, 0.12, 0.18] })],
    ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 1, h: 12, hills: 1, grass: [0.30, 0.26, 0.20] })],
    ["floods", (api, sv, h) => floods(api, sv, h, { cool: false })],
  ],
  harbour: [
    ["shore", (api, sv, h) => shore(api, sv, h, { col: [0.18, 0.38, 0.56] })],
    ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 1, h: 9, hills: 0, livery: "alu", livery2: "scaffold" })],
  ],
  marina: [
    ["shore", (api, sv, h) => shore(api, sv, h, { col: [0.04, 0.08, 0.14] })],
    ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 1, h: 9, hills: 0, livery: "navy", livery2: "alu" })],
    ["floods", (api, sv, h) => floods(api, sv, h, { cool: true, dist: 26, h: 22 })],
  ],
  tilke: [
    ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 3, h: 16, hills: 2, stand: true, livery: "navy", livery2: "teal" })],
    // The hotel over the pit straight, set back behind the stands.
    ["hotel", (api, sv) => { if (api.building) api.building(api.K(0.03), -sv.pitSide, 120, 30, 60, 30, { kind: "slab" }); }],
    ["horizon", (api, sv, h) => horizon(api, sv, h, { count: 20, h0: 6, h1: 5, cols: [[0.24, 0.44, 0.22]] })],
    ["paddock", (api, sv, h) => paddock(api, sv, h, { count: 8 })],
  ],
  autumn: [
    ["belts", (api, sv, h) => belts(api, sv, h, { coverage: 0.4, gap: 34, col: [0.66, 0.36, 0.12], col2: [0.52, 0.28, 0.10], pineFrac: 0.1, hMin: 9, hMax: 16 })],
    ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 1, h: 11, hills: 3, livery: "terracotta" })],
    ["horizon", (api, sv, h) => horizon(api, sv, h, { count: 24, rMin: 160, rMax: 300, h0: 12, h1: 10, cols: [[0.36, 0.40, 0.18], [0.44, 0.38, 0.16]] })],
    ["village", (api, sv, h) => village(api, sv, h, { count: 8, walls: [[0.78, 0.70, 0.58], [0.70, 0.52, 0.40]] })],
  ],
  tuscany: [
    ["belts", (api, sv, h) => belts(api, sv, h, { coverage: 0.25, gap: 36, col: [0.18, 0.28, 0.12], col2: [0.30, 0.34, 0.14], pineFrac: 0.7, hMin: 10, hMax: 18, density: 0.3 })],
    ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 1, h: 11, hills: 3, livery: "terracotta", livery2: "sandstone", grass: [0.46, 0.44, 0.20] })],
    ["horizon", (api, sv, h) => horizon(api, sv, h, { count: 26, rMin: 160, rMax: 320, h0: 16, h1: 14, cols: [[0.52, 0.46, 0.22], [0.38, 0.40, 0.18], [0.60, 0.50, 0.28]] })],
    ["village", (api, sv, h) => village(api, sv, h, { count: 9, walls: [[0.86, 0.72, 0.52], [0.82, 0.62, 0.42]], roof: [0.70, 0.36, 0.22], roofType: "hip" })],
  ],
  coast: [
    ["shore", (api, sv, h) => shore(api, sv, h, { col: [0.12, 0.34, 0.52], second: false, size: [900, 0.2, 1100] })],
    ["belts", (api, sv, h) => belts(api, sv, h, { coverage: 0.2, gap: 34, col: [0.18, 0.34, 0.16], col2: [0.22, 0.38, 0.18], pineFrac: 0.6, hMin: 10, hMax: 16 })],
    ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 2, h: 12, hills: 2, livery: "sandstone", livery2: "alu" })],
    ["horizon", (api, sv, h) => horizon(api, sv, h, { count: 18, rMin: 200, rMax: 360, h0: 18, h1: 16, cols: [[0.40, 0.42, 0.26], [0.50, 0.46, 0.34]] })],
    ["funfair", (api, sv, h) => funfair(api, sv, h, { dist: 140, r: 24 })],
  ],
  savanna: [
    ["belts", (api, sv, h) => belts(api, sv, h, { coverage: 0.15, gap: 40, col: [0.36, 0.40, 0.16], col2: [0.42, 0.42, 0.18], pineFrac: 0, hMin: 7, hMax: 11, density: 0.2 })],
    ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 1, h: 12, hills: 2, livery: "orange", livery2: "sandstone", grass: [0.58, 0.50, 0.26] })],
    ["horizon", (api, sv, h) => horizon(api, sv, h, { mountain: true, count: 10, rMin: 1200, rMax: 1800, w0: 900, w1: 500, h0: 140, h1: 120, rough: 0.15, snowline: 1.6, rock: [0.46, 0.44, 0.50], forest: [0.40, 0.40, 0.30] })],
  ],
  ardennes: [
    ["belts", (api, sv, h) => belts(api, sv, h, { coverage: 0.5, gap: 28, col: [0.10, 0.22, 0.12], col2: [0.16, 0.30, 0.16], pineFrac: 0.6, hMin: 14, hMax: 24, density: 0.32, second: true })],
    ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 1, h: 11, hills: 2, livery: "darkSteel", livery2: "crimson" })],
    ["horizon", (api, sv, h) => horizon(api, sv, h, { mountain: true, count: 12, rMin: 700, rMax: 1200, w0: 700, w1: 400, h0: 160, h1: 120, rough: 0.25, snowline: 1.6, rock: [0.30, 0.32, 0.30], forest: [0.12, 0.22, 0.14] })],
    ["village", (api, sv, h) => village(api, sv, h, { count: 7, walls: [[0.62, 0.60, 0.56], [0.70, 0.66, 0.60]], roof: [0.26, 0.28, 0.30] })],
  ],
  airfield: [
    ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 2, h: 12, hills: 3, livery: "steel", livery2: "scaffold" })],
    ["hangars", (api, sv, h) => hangars(api, sv, h)],
    ["belts", (api, sv, h) => belts(api, sv, h, { coverage: 0.15, gap: 60, col: [0.20, 0.34, 0.16], col2: [0.24, 0.38, 0.18], pineFrac: 0.1, hMin: 8, hMax: 13, density: 0.3 })],
    ["horizon", (api, sv, h) => horizon(api, sv, h, { count: 18, h0: 5, h1: 4, cols: [[0.22, 0.38, 0.20], [0.26, 0.40, 0.22]] })],
    ["paddock", (api, sv, h) => paddock(api, sv, h)],
  ],
  canyon: [
    ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 1, h: 12, hills: 2, livery: "terracotta", livery2: "orange", grass: [0.58, 0.34, 0.20] })],
    ["buttes", (api, sv, h) => buttes(api, sv, h, { count: 14, rMin: 500, rMax: 1100 })],
  ],
  winter: [
    ["belts", (api, sv, h) => belts(api, sv, h, { coverage: 0.45, gap: 30, col: [0.10, 0.22, 0.14], col2: [0.14, 0.26, 0.18], pineFrac: 0.95, hMin: 12, hMax: 22, density: 0.3, second: true })],
    ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 1, h: 11, hills: 2, livery: "darkSteel", livery2: "crimson", grass: [0.84, 0.86, 0.90], riser: [0.72, 0.74, 0.78] })],
    ["horizon", (api, sv, h) => horizon(api, sv, h, { mountain: true, count: 12, rMin: 900, rMax: 1500, w0: 700, w1: 400, h0: 280, h1: 180, rough: 0.3, snowline: 0.2, snow: [0.96, 0.97, 1.0], rock: [0.40, 0.42, 0.46], forest: [0.12, 0.22, 0.16] })],
    ["chalets", (api, sv, h) => village(api, sv, h, { count: 7, walls: [[0.42, 0.28, 0.18], [0.50, 0.34, 0.22]], roof: [0.88, 0.90, 0.94], roofType: "gable", h: 6 })],
  ],
  twilight: [
    ["shore", (api, sv, h) => shore(api, sv, h, { col: [0.04, 0.10, 0.16], second: false, size: [500, 0.2, 600] })],
    ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 2, h: 14, hills: 2, stand: true, livery: "navy", livery2: "teal" })],
    ["hotel", (api, sv) => { if (api.building) api.building(api.K(0.03), -sv.pitSide, 110, 40, 34, 40, { kind: "slab" }); }],
    ["floods", (api, sv, h) => floods(api, sv, h, { cool: false })],
    ["paddock", (api, sv, h) => paddock(api, sv, h)],
    ["funfair", (api, sv, h) => funfair(api, sv, h, { dist: 150, r: 30 })],
  ],
  jungle: [
    ["belts", (api, sv, h) => belts(api, sv, h, { coverage: 0.55, gap: 30, col: [0.12, 0.36, 0.14], col2: [0.18, 0.44, 0.16], pineFrac: 0, hMin: 12, hMax: 22, density: 0.32, second: true })],
    ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 1, h: 11, hills: 2, livery: "teal", livery2: "steel" })],
    ["horizon", (api, sv, h) => horizon(api, sv, h, { mountain: true, count: 12, rMin: 800, rMax: 1300, w0: 600, w1: 360, h0: 220, h1: 160, rough: 0.35, snowline: 1.6, rock: [0.26, 0.34, 0.24], forest: [0.10, 0.30, 0.12] })],
    ["village", (api, sv, h) => village(api, sv, h, { count: 6, walls: [[0.86, 0.80, 0.62], [0.60, 0.74, 0.62]], roof: [0.48, 0.36, 0.20], roofType: "hip" })],
  ],
  lakeside: [
    ["shore", (api, sv, h) => shore(api, sv, h, { col: [0.10, 0.28, 0.46], second: false, size: [800, 0.2, 1000] })],
    ["belts", (api, sv, h) => belts(api, sv, h, { coverage: 0.45, gap: 30, col: [0.12, 0.28, 0.14], col2: [0.16, 0.32, 0.18], pineFrac: 0.85, hMin: 12, hMax: 22, density: 0.3 })],
    ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 1, h: 11, hills: 2, livery: "crimson", livery2: "steel" })],
    ["horizon", (api, sv, h) => horizon(api, sv, h, { count: 24, rMin: 180, rMax: 320, h0: 14, h1: 10, cols: [[0.14, 0.28, 0.16], [0.18, 0.32, 0.18]] })],
    ["village", (api, sv, h) => village(api, sv, h, { count: 8, walls: [[0.62, 0.14, 0.10], [0.66, 0.18, 0.12], [0.90, 0.86, 0.72]], roof: [0.20, 0.20, 0.22], roofType: "gable" })],
  ],
  moorland: [
    ["belts", (api, sv, h) => belts(api, sv, h, { coverage: 0.12, gap: 50, col: [0.22, 0.32, 0.18], col2: [0.26, 0.34, 0.20], pineFrac: 0.3, hMin: 7, hMax: 12, density: 0.2 })],
    ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 1, h: 10, hills: 3, livery: "steel", livery2: "navy", grass: [0.36, 0.38, 0.22] })],
    ["horizon", (api, sv, h) => horizon(api, sv, h, { mountain: true, count: 14, rMin: 700, rMax: 1200, w0: 800, w1: 500, h0: 150, h1: 110, rough: 0.2, snowline: 1.6, rock: [0.40, 0.36, 0.40], forest: [0.38, 0.28, 0.40] })],
    ["village", (api, sv, h) => village(api, sv, h, { count: 7, walls: [[0.56, 0.54, 0.50], [0.48, 0.46, 0.44]], roof: [0.22, 0.24, 0.26], roofType: "gable", h: 4 })],
  ],
  metropolis: [
    ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 2, h: 12, hills: 0, livery: "steel", livery2: "alu" })],
  ],
  shipyard: [
    ["shore", (api, sv, h) => shore(api, sv, h, { col: [0.28, 0.34, 0.38], size: [800, 0.2, 1000] })],
    ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 1, h: 11, hills: 1, livery: "steel", livery2: "concrete", grass: [0.36, 0.38, 0.36] })],
    ["hangars", (api, sv, h) => hangars(api, sv, h)],
    ["belts", (api, sv, h) => belts(api, sv, h, { coverage: 0.1, gap: 55, col: [0.20, 0.30, 0.18], col2: [0.24, 0.34, 0.20], pineFrac: 0.05, hMin: 7, hMax: 12, density: 0.2 })],
    ["horizon", (api, sv, h) => horizon(api, sv, h, { count: 16, rMin: 200, rMax: 340, h0: 8, h1: 10, cols: [[0.42, 0.44, 0.46], [0.38, 0.40, 0.42]] })],
    ["paddock", (api, sv, h) => paddock(api, sv, h, { count: 5 })],
  ],
  saltflat: [
    ["belts", (api, sv, h) => belts(api, sv, h, { coverage: 0.08, gap: 70, col: [0.42, 0.44, 0.24], col2: [0.48, 0.46, 0.28], pineFrac: 0, hMin: 5, hMax: 9, density: 0.15 })],
    ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 1, h: 10, hills: 1, second: false, livery: "alu", grass: [0.88, 0.86, 0.80] })],
    ["horizon", (api, sv, h) => horizon(api, sv, h, { count: 20, rMin: 220, rMax: 380, len: 220, wid: 40, h0: 6, h1: 5, cols: [[0.86, 0.84, 0.76], [0.80, 0.76, 0.66]] })],
  ],
  vineyard: [
    ["belts", (api, sv, h) => belts(api, sv, h, { coverage: 0.3, gap: 32, col: [0.24, 0.36, 0.16], col2: [0.40, 0.42, 0.18], pineFrac: 0.55, hMin: 8, hMax: 15, density: 0.28 })],
    ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 1, h: 11, hills: 3, livery: "sandstone", livery2: "terracotta", grass: [0.50, 0.46, 0.20] })],
    ["horizon", (api, sv, h) => horizon(api, sv, h, { count: 26, rMin: 150, rMax: 300, h0: 14, h1: 12, cols: [[0.56, 0.50, 0.22], [0.42, 0.46, 0.20], [0.62, 0.48, 0.24]] })],
    ["village", (api, sv, h) => village(api, sv, h, { count: 8, walls: [[0.84, 0.78, 0.64], [0.72, 0.58, 0.40]], roof: [0.52, 0.28, 0.18], roofType: "hip" })],
  ],
  stadium: [
    ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 3, h: 18, hills: 3, stand: true, second: true, livery: "steel", livery2: "darkSteel" })],
    ["floods", (api, sv, h) => floods(api, sv, h, { cool: true, dist: 24, h: 28 })],
    ["paddock", (api, sv, h) => paddock(api, sv, h, { count: 7 })],
    ["horizon", (api, sv, h) => horizon(api, sv, h, { count: 12, rMin: 180, rMax: 280, h0: 4, h1: 3, cols: [[0.12, 0.14, 0.16], [0.10, 0.12, 0.14]] })],
  ],
  island: [
    ["shore", (api, sv, h) => shore(api, sv, h, { col: [0.08, 0.52, 0.58], size: [900, 0.2, 1100] })],
    ["belts", (api, sv, h) => belts(api, sv, h, { coverage: 0.35, gap: 34, col: [0.14, 0.40, 0.16], col2: [0.20, 0.46, 0.18], pineFrac: 0, hMin: 10, hMax: 18, density: 0.3 })],
    ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 2, h: 12, hills: 2, livery: "pastel", livery2: "teal" })],
    ["horizon", (api, sv, h) => horizon(api, sv, h, { count: 18, rMin: 200, rMax: 360, h0: 12, h1: 10, cols: [[0.30, 0.48, 0.28], [0.50, 0.46, 0.30]] })],
    ["funfair", (api, sv, h) => funfair(api, sv, h, { dist: 145, r: 22 })],
  ],
};
DRESS.blossom = [
  ["belts", (api, sv, h) => belts(api, sv, h, { coverage: 0.3, gap: 38, col: [0.76, 0.42, 0.54], col2: [0.88, 0.62, 0.70], pineFrac: 0, hMin: 7, hMax: 12, density: 0.28 })],
  ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 1, h: 10, hills: 2, livery: "pastel", livery2: "alu" })],
  ["horizon", (api, sv, h) => horizon(api, sv, h, { count: 20, h0: 12, h1: 8, cols: [[0.38, 0.48, 0.28], [0.60, 0.48, 0.46]] })],
  ["village", (api, sv, h) => village(api, sv, h, { count: 5, walls: [[0.86, 0.80, 0.70], [0.82, 0.72, 0.72]], roof: [0.34, 0.36, 0.40], roofType: "gable" })],
];
DRESS.volcanic = [
  ["shore", (api, sv, h) => shore(api, sv, h, { col: [0.10, 0.26, 0.36], second: false, size: [750, 0.2, 850] })],
  ["belts", (api, sv, h) => belts(api, sv, h, { coverage: 0.1, gap: 45, col: [0.24, 0.30, 0.18], col2: [0.30, 0.34, 0.22], pineFrac: 0, hMin: 5, hMax: 9, density: 0.2 })],
  ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 1, h: 11, hills: 1, second: false, livery: "alu" })],
  ["horizon", (api, sv, h) => horizon(api, sv, h, { mountain: true, count: 9, rMin: 850, rMax: 1400, w0: 600, w1: 360, h0: 210, h1: 160, rough: 0.35, snowline: 1.6, rock: [0.28, 0.28, 0.31], forest: [0.22, 0.27, 0.20] })],
];
DRESS.fjord = [
  ["shore", (api, sv, h) => shore(api, sv, h, { col: [0.14, 0.34, 0.46], second: false, size: [650, 0.2, 900] })],
  ["belts", (api, sv, h) => belts(api, sv, h, { coverage: 0.18, gap: 42, col: [0.14, 0.28, 0.24], col2: [0.18, 0.34, 0.28], pineFrac: 1, hMin: 12, hMax: 22, density: 0.24 })],
  ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 1, h: 11, hills: 1, second: false, livery: "alu" })],
  ["horizon", (api, sv, h) => horizon(api, sv, h, { mountain: true, count: 10, rMin: 900, rMax: 1450, w0: 700, w1: 400, h0: 280, h1: 180, snowline: 0.4, rock: [0.38, 0.44, 0.48], forest: [0.18, 0.30, 0.24] })],
];
DRESS.badlands = [
  ["buttes", (api, sv, h) => buttes(api, sv, h, { count: 10, rMin: 650, rMax: 1250 })],
  ["horizon", (api, sv, h) => horizon(api, sv, h, { count: 22, rMin: 230, rMax: 400, len: 180, wid: 48, h0: 22, h1: 20, cols: [[0.58, 0.30, 0.20], [0.68, 0.40, 0.26]] })],
  ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 1, h: 10, hills: 1, second: false, livery: "sandstone" })],
];
DRESS.redwood = [
  ["belts", (api, sv, h) => belts(api, sv, h, { coverage: 0.4, gap: 48, col: [0.14, 0.30, 0.20], col2: [0.20, 0.36, 0.24], pineFrac: 1, hMin: 26, hMax: 40, density: 0.22 })],
  ["stands", (api, sv, h) => stands(api, sv, h, { tiers: 1, h: 10, hills: 2, second: false, livery: "darkSteel" })],
  ["horizon", (api, sv, h) => horizon(api, sv, h, { count: 20, rMin: 220, rMax: 400, h0: 20, h1: 14, cols: [[0.20, 0.34, 0.22], [0.24, 0.38, 0.24]] })],
  ["village", (api, sv, h) => village(api, sv, h, { count: 4, walls: [[0.56, 0.42, 0.28], [0.64, 0.50, 0.34]], roof: [0.30, 0.30, 0.28], roofType: "gable" })],
];
/** Three hangars (corrugated-metal box, gable roof, dark door facing the track)
 *  and a control tower on the outside of the second-longest straight.
 *  Primitives, not building(): that draws office windows. Each footprint is
 *  checked against the tarmac first (onTrack), and the guarded addBox /
 *  addPrism cull any piece that would still reach the road. track-themes.js:840 */
function hangars(api: SceneryApi, sv: ThemeSurvey, h: ThemeHash): void {
  const { anchor, addBox, addPrism, out, MAT, onTrack } = api;
  if (!anchor || !addBox || !addPrism || !sv.straights.length) return;
  const st = sv.straights[1] || sv.straights[0]!, side = sv.outward(st.k0);
  const span = (st.s1 - st.s0 + 1) % 1;
  const W = 40, H = 12, D = 30, ROOF = 7;   // W: away from the road, D: along it
  const prev = out._mat;
  const piece = (k: number, gap: number, w: number, hh: number, d: number, col: RVec3, roof: number, lift = 0) => {
    const a = anchor(k, side, gap + w / 2), b: Basis = [a.r, a.u, a.t];
    if (onTrack && onTrack(a.c[0], a.c[2], Math.hypot(w, d) / 2 + 6)) return;
    const at = (dr: number, du: number): RVec3 => [a.c[0] + a.r[0] * dr + a.u[0] * du, a.c[1] + a.r[1] * dr + a.u[1] * du, a.c[2] + a.r[2] * dr + a.u[2] * du];
    out._mat = MAT.METAL;
    addBox(out, at(0, lift + hh / 2), [w, hh, d], col, b);
    if (roof) {
      out._mat = MAT.ROOF;
      addPrism(out, at(0, hh), [d, roof, w], [0.42, 0.46, 0.50], [a.t, a.u, a.r]);
      out._mat = MAT.FLAT;   // the door: a dark panel on the track-facing wall
      addBox(out, at(-side * (w / 2 + 0.15), hh * 0.4), [0.3, hh * 0.8, d * 0.7], [0.14, 0.15, 0.17], b);
    }
  };
  for (let i = 0; i < 3; i++) piece(api.K((st.s0 + span * (0.22 + i * 0.22)) % 1), 55 + h("hangar", i) * 15, W, H, D, [0.60, 0.62, 0.64], ROOF);
  piece(api.K((st.s0 + span * 0.82) % 1), 60, 8, 22, 8, [0.84, 0.84, 0.80], 0);           // tower
  piece(api.K((st.s0 + span * 0.82) % 1), 58, 12, 4, 12, [0.30, 0.42, 0.48], 0, 22);      // its glass cab, on top
  out._mat = prev;
}
/** addFrustum as buttes() calls it: f1-game passes `null` for the basis, the
 *  contract types it `basis?: Basis`. TODO(lane-scenery): accept `Basis | null`. */
type NullBasisFrustum = (o: SceneryBuffer, c: RVec3, rBase: number, rTop: number, h: number, col: RVec3, seg?: number, basis?: Basis | null) => boolean;
/** Flat-topped sandstone buttes on a ring beyond the lap: a tapered wall, a flat
 *  cap and a scree skirt (mountain() always comes to a peak). track-themes.js:867 */
function buttes(api: SceneryApi, sv: ThemeSurvey, h: ThemeHash, opts: ButteOpts): void {
  const { out, MAT, pyMin, onTrack } = api;
  const addFrustum = api.addFrustum as NullBasisFrustum;
  const count = Math.min(28, opts.count || 14), r0 = sv.radius + (opts.rMin || 500), r1 = sv.radius + (opts.rMax || 1100);
  const rock: RVec3 = [0.62, 0.30, 0.18], band: RVec3 = [0.70, 0.38, 0.22], scree: RVec3 = [0.56, 0.32, 0.20];
  const prev = out._mat;
  out._mat = MAT ? MAT.ROCK : prev;
  for (let i = 0; i < count; i++) {
    const a = (i + (h("butteA", i) - 0.5) * 0.6) / count * Math.PI * 2;
    const rr = r0 + h("butteR", i) * (r1 - r0);
    const x = sv.cx + Math.cos(a) * rr, z = sv.cz + Math.sin(a) * rr;
    const base = 90 + h("butteW", i) * 170, hh = 80 + h("butteH", i) * 130, top = base * (0.72 + h("butteT", i) * 0.14);
    if (onTrack && onTrack(x, z, base * 1.5 + 40)) continue;
    const y = pyMin - 2, seg = 9;
    addFrustum(out, [x, y, z], base * 1.45, base, hh * 0.22, scree, seg, null);             // scree skirt
    addFrustum(out, [x, y + hh * 0.22, z], base, (base + top) / 2, hh * 0.45, rock, seg, null); // lower wall
    addFrustum(out, [x, y + hh * 0.67, z], (base + top) / 2, top, hh * 0.33, band, seg, null);  // upper band
    addFrustum(out, [x, y + hh, z], top, top * 0.02, 1.5, band, seg, null);                   // flat cap
  }
  out._mat = prev;
}

/** The preset's dressers plus what the scenery options add: flood masts at NIGHT
 *  on a day preset, a forest belt where MANY TREES meets a preset with none (not
 *  on a street, where the city fills the ground). track-themes.js:891 */
function dressersFor(themeId: string, look: ThemeLook): ThemeDresser[] {
  const list = DRESS[themeId]!.slice(), p = get(themeId), has = (n: string) => list.some((d) => d[0] === n);
  list.push(["trackside", (api, sv, h) => trackside(api, sv, h, { street: !!p.street })]);
  if (look.time === "night" && !p.night && !has("floods")) list.push(["floods", (api, sv, h) => floods(api, sv, h, { cool: p.theme !== "desert" })]);
  if (look.trees === "many" && !p.street && !has("belts")) {
    const fol = (p.furniture && p.furniture.fol) || [0.22, 0.40, 0.20];
    list.push(["belts", (api, sv, h) => belts(api, sv, h, { coverage: 0.2, gap: 40, col: fol, col2: rgb(fol, 0.85), pineFrac: p.furniture && p.furniture.tree === "fir" ? 0.9 : 0.2, hMin: 8, hMax: 14, density: 0.3 })]);
  }
  return list;
}

/** The generated `scenery(api)` closure for a design. Every draw is seeded from
 *  the design, so the same share code dresses the same circuit on every
 *  machine. The build must never strand on a theme: a failed survey leaves the
 *  generic dressing alone, and each dresser runs in its own try, so one that
 *  throws is skipped and the others still stand. track-themes.js:909 */
export function sceneryFor(design: ThemeDesign | null | undefined): (api: SceneryApi) => void {
  const themeId: string = has(design && design.theme) ? design!.theme! : ORDER[0]!;
  const seed = ((design && design.seed) as number) >>> 0 || 1;
  return function customScenery(api: SceneryApi): void {
    const h: ThemeHash = (tag, i) => unit(seed, themeId, tag, i == null ? 0 : i);
    let sv: ThemeSurvey;
    try { sv = survey(api); } catch {
      // f1-game logs (Log.warn, dropped): generic dressing only.
      return;
    }
    sv.look = lookOf(design);
    let failed = 0;
    for (const [, dress] of dressersFor(themeId, sv.look)) {
      try { dress(api, sv, h); } catch {
        failed++;   // f1-game logs the dresser's name (Log.warn, dropped); the others stand
      }
    }
    // Slice H: authored props (design.props) after the theme dressers. f1-game
    // resolves the lazy TrackDesignerProps global at call time; imported here.
    let authored = 0;
    if (design && design.props) {
      try { authored = dressProps(api, sv, design.props) || 0; } catch {
        failed++;   // f1-game Log.warn (dropped): theme dressers stand
      }
    }
    // f1-game's closing Log.info summary (theme, look, straights, slow, props, failed) is dropped.
    void authored; void failed;
  };
}
