/**
 * CircuitDef: the authored data of one circuit, ported from f1-game's
 * `js/circuits/<id>.js` by `tools/codemod-circuits.mjs`.
 *
 * The shape is derived from all 52 shipped defs (17 keys present in every def,
 * 26 optional) and from the engine code that reads them (f1-game
 * `js/track/core/def.js` `fromRaw`, `js/track/tracks.js`, `js/track/core/pit.js`,
 * `js/track/core/space.js`, `js/track/scenery/{build-props,data}.js`).
 *
 * ## Fractions and coordinate spaces
 *
 * A "frac" is a lap fraction in [0, 1). f1-game has two lap frames:
 * - SOURCE: the order of `path.pts` as imported (the OSM trace), before the
 *   start-line rotation and `reverse`.
 * - RACING: after rotating the lap so s = 0 is the start/finish line
 *   (`startFrac`) and flipping it when `reverse` is set.
 *
 * `sectors`, `turns` and frac `bankZones` are RACING-space. `elevations`,
 * `bridges` and `hwZones` are remapped from the authoring origin at
 * materialize time (f1-game `def.js` `materializeListPoints`).
 *
 * ## The `_sceneryShift` caveat (f1-game AGENTS.md "Frac-keyed def tables")
 *
 * When `sceneryStartFrac` is set, the engine computes a derived
 * `def._sceneryShift` (an ARC-length fraction from the corrected start line to
 * the origin the dressing was authored against; `tracks.js` buildCenterline).
 * Frac-keyed tables must be consumed through the compensated idiom
 * (`bankingProfile` / `buildCenterline`): reading a raw `frac` against the
 * built lap lands it up to 2/3 of a lap away. `_sceneryShift` is engine output,
 * never authored, so it is not part of this type.
 */

/** Linear RGB, each channel nominally in [0, 1]. */
export type Rgb = readonly [number, number, number];

/** A 3-vector (e.g. an un-normalised sun direction). */
export type Vec3 = readonly [number, number, number];

/** A plan-view centreline point `[x, z]` in metres. */
export type PathPoint = readonly [number, number];

/** Visual theme; picks the furniture / kit / city defaults (`FURN_DEF`, `KIT_DEF`). */
export type Theme = "green" | "desert" | "modern" | "street_day" | "street_night";

/** Scenery theme override (tracks.js); absent falls back by `theme`. */
export type SceneryTheme = "desert" | "permanent" | "street" | "park" | "night-event";

/**
 * Which lap frame the circuit's `scenery(api)` callback is authored in
 * (`TrackSpace.scenerySpace`). f1-game falls back to "source" for a reversed
 * lap and "racing" otherwise when the key is absent; every shipped def sets it.
 */
export type SceneryCoordinates = "racing" | "source";

/** Terrain material beyond the runoff verge (mesh.js ribbon). */
export type TerrainMat = "SAND" | "SNOW" | "CONCRETE";

/**
 * Sky / ground palette. Every key is optional and merged over the engine's
 * day or night default (`dayPal` / `nightPal` in def.js), chosen by `night`.
 */
export interface Palette {
  zenith?: Rgb;
  horizon?: Rgb;
  /** Sun disc colour. */
  sun?: Rgb;
  /** Directional light colour. */
  sunColor?: Rgb;
  /** Raw sun direction; the engine normalises it. */
  sunDir?: Vec3;
  ambientSky?: Rgb;
  ambientGround?: Rgb;
  grass?: Rgb;
  runoff?: Rgb;
  /** Runtime fog colour. */
  fog?: Rgb;
  /** Legacy authored fog colour: copied to `fog` when `fog` is absent. */
  fogColor?: Rgb;
  fogDensity?: number;
  asphalt?: Rgb;
  line?: Rgb;
  kerbA?: Rgb;
  kerbB?: Rgb;
}

/** Scenery kinds a dressing exclusion can suppress (build-props.js). */
export type DressingKind = "all" | "foliage" | "city" | "lamps" | "floodlights" | "lighting";

interface DressingExclusionBase {
  /** Lap-fraction window start; omit both `s0` and `s1` for the whole lap. Wraps when `s1 < s0`. */
  s0?: number;
  s1?: number;
  /** -1 left / +1 right of the racing direction (flipped on a reversed lap); omit for both sides. */
  side?: -1 | 1;
}

/** Suppress generic dressing inside a frac window (sightlines, pits, water). */
export type DressingExclusion =
  | (DressingExclusionBase & { kind: DressingKind; kinds?: never })
  | (DressingExclusionBase & { kinds: readonly DressingKind[]; kind?: never });

/** A Gaussian-ish elevation bump on the authored centreline (ignored when surveyed elevations exist). */
export interface Elevation {
  /** Centre, as a lap fraction in the authoring frame. */
  s: number;
  /** Half-length of the bump in metres. */
  halfM: number;
  /** Peak height change in metres (negative = dip). */
  rise: number;
}

/** A raised deck (figure-8 crossover); pillars are auto-placed under it. */
export interface Bridge {
  /** Centre, as a lap fraction in the authoring frame. */
  s: number;
  halfM: number;
  rise: number;
}

/** Half-width overlay on the centreline: the only way to narrow or widen a section. */
export interface HwZone {
  /** Window start / end as lap fractions; wraps when `s1 < s0`. */
  s0: number;
  s1: number;
  /** Half-width in metres inside the zone (vs `baseHW`). */
  hw: number;
  /** Shoulder length of the smoothstep blend, as a lap fraction. */
  ease: number;
}

interface BankZoneBase {
  /** Bank angle in degrees. */
  angleDeg: number;
  /** Width of the banked window in metres. */
  widthM: number;
}

/**
 * A banked corner. Prefer `{ turn }` (1-based index into `turns`, racing
 * space, no shift). A `{ frac }` zone that lands on a straight > 60 m from any
 * apex is re-seated on the nearest one, and it is subject to `_sceneryShift`.
 */
export type BankZone =
  | (BankZoneBase & { turn: number; frac?: never })
  | (BankZoneBase & { frac: number; turn?: never });

/** Roadside tree species (build-props.js `SPECIES` plus the palm / fir / broad meshes). */
export type TreeSpecies =
  | "palm"
  | "fir"
  | "broad"
  | "none"
  | "cypress"
  | "stonePine"
  | "broadleafFall"
  | "acacia"
  | "plane";

/** Broadleaf crown form (build-props.js `CROWNS`); absent is "round". */
export type TreeCrown = "vase" | "weeping" | "columnar" | "lobed";

export type LampFamily = "arm" | "globe" | "post" | "none";

/** Roadside furniture families. */
export interface Furniture {
  tree: TreeSpecies;
  /** Foliage tint. */
  fol: Rgb;
  lamp: LampFamily;
  /** Lamp light colour. */
  lc?: Rgb;
  /** Thin the roadside scatter. */
  sparse?: true;
  treeCrown?: TreeCrown;
}

/** Trackside kit families (structures.js; defaults per theme in `KIT_DEF`). */
export interface Kit {
  marshal: "container" | "tent" | "cabin" | "hut" | "kiosk" | "bunker" | "tower";
  rail: "wArmco" | "armco" | "doubleArmco" | "safer" | "jersey" | "cable";
  fence: "panelled" | "hoarding" | "mesh" | "leaning" | "chainlink" | "palisade";
  tyre: "stack" | "tecpro" | "airfence";
  board: "monopole" | "fascia" | "panel" | "arched" | "banner" | "led" | "trivision" | "tower";
  gantry: "portal" | "cantilever" | "truss" | "box";
  camera: "monopole" | "scaffold" | "lattice";
  hoarding: "panel" | "barrierTop" | "banner" | "led" | "double";
}

/** Grandstand livery names (scenery/data.js `STAND_LIVERIES` keys). */
export type StandLivery =
  | "steel"
  | "darkSteel"
  | "concrete"
  | "alu"
  | "scaffold"
  | "sandstone"
  | "terracotta"
  | "pastel"
  | "crimson"
  | "navy"
  | "teal"
  | "orange";

/** Street armco colour sequence. */
export interface BarrierColours {
  a: Rgb;
  b: Rgb;
  c: Rgb;
  night: Rgb;
  tyre: Rgb;
}

/** Neon colour names (scenery/data.js `NC` keys). */
export type NeonColour =
  | "mag"
  | "cyan"
  | "gold"
  | "violet"
  | "blue"
  | "orange"
  | "red"
  | "teal"
  | "white"
  | "green"
  | "pink"
  | "lime"
  | "ice"
  | "yellow"
  | "purple"
  | "rose"
  | "amber";

/** Day facade colour names (scenery/data.js `DC` keys). */
export type DayColour =
  | "cream"
  | "sand"
  | "tan"
  | "stone"
  | "terra"
  | "brick"
  | "ochre"
  | "white"
  | "greyblue"
  | "slate"
  | "paleblue"
  | "teal"
  | "peach"
  | "pink"
  | "mint"
  | "aqua"
  | "lemon"
  | "coral"
  | "concrete"
  | "charcoal"
  | "graphite"
  | "steel"
  | "darkglass"
  | "bluglass"
  | "bronze"
  | "gold"
  | "copper";

/** City building forms: scenery/data.js `BLD` plus the extra forms city.js draws. */
export type BuildingKind =
  | "pyramid"
  | "screen"
  | "clad"
  | "setback"
  | "tiered"
  | "podium"
  | "slab"
  | "twin"
  | "jenga"
  | "cylinder"
  | "spire"
  | "dome"
  | "chevron"
  | "notch"
  | "fin"
  | "antenna"
  | "cross"
  | "arch"
  | "ziggurat"
  | "drum"
  | "hall";

/** Skyline recipe (scenery/data.js `resolveCityStyle`). */
export interface CityStyle {
  neon: readonly NeonColour[];
  /** Probability bias toward neon buildings. */
  bias: number;
  /** Front-row height range `[min, max]` in metres. */
  fh: readonly [number, number];
  /** Back-row height range `[min, max]` in metres. */
  bh: readonly [number, number];
  kinds: readonly BuildingKind[];
  /** Forms picked for neon-lit buildings (shipped defs use "screen", "clad", "antenna"). */
  neonKinds: readonly BuildingKind[];
  /** Night (`n`) / day (`d`) facade tone, or null for the theme default. */
  tone: { n: Rgb; d: Rgb } | null;
  dayPal: readonly DayColour[];
}

/** One roof-profile knot: `[t along the garage row 0..1, front height m, back height m]` (heights 9.6..18). */
export type RoofKnot = readonly [number, number, number];

/** Bespoke pit-building dressing (pit.js `architecture`); an invalid recipe is ignored. */
export interface PitArchitecture {
  /** 2..7 knots, strictly increasing t, first t = 0, last t = 1. */
  roofProfile: readonly RoofKnot[];
  roofColor?: Rgb;
  fasciaColor?: Rgb;
  soffitColor?: Rgb;
  edgeColor?: Rgb;
}

/** Pit-lane band widths in metres from the racing-surface edge outward; merged over the mode's defaults. */
export interface PitBands {
  verge?: number;
  platform?: number;
  fast?: number;
  corridor?: number;
  work?: number;
}

/** The pit complex's authored choices (`TrackPit.resolve`). */
export interface PitSpec {
  /** -1 left / +1 right of the racing direction. */
  side?: -1 | 1;
  /** Band set; absent is "street" on a `street` circuit, else "full". "narrow" is painted (no wall, no bays). */
  mode?: "full" | "street" | "narrow";
  /** Pit speed limit; absent uses the mode's default. */
  limitKph?: number;
  bands?: PitBands;
  /** `false` builds no garage bays. */
  bays?: boolean;
  architecture?: PitArchitecture;
}

/** The imported centreline (tools/track/import-circuit-path.mjs). */
export interface CircuitPath {
  /** Lap length in metres of the source trace. */
  len: number;
  /** Closed loop of plan points in SOURCE order; the last point does not repeat the first. */
  pts: readonly PathPoint[];
}

/** Per-circuit overrides of the scenery theme palette. */
export interface SceneryThemeOverrides {
  palette?: {
    shell?: Rgb;
    roof?: Rgb;
  };
}

export interface CircuitDef {
  // ── present in all 52 defs ────────────────────────────────────────────────
  /** Stable id (file name); also the key for elevations, scenery and saves. */
  id: string;
  /** Real-world direction: true when the race runs against the source trace order. */
  reverse: boolean;
  /** Display name, upper case (e.g. "MONZA"). */
  name: string;
  /** Grand Prix title (e.g. "Italian GP"). */
  gp: string;
  country: string;
  /** Night race: picks the night palette defaults and lighting. */
  night: boolean;
  theme: Theme;
  /** Real lap length in km (drives the default GP lap count). */
  lengthKm: number;
  /** Base road half-width in metres. */
  baseHW: number;
  sceneryCoordinates: SceneryCoordinates;
  pal: Palette;
  /** Sector boundaries: two RACING-lap fractions (S1|S2, S2|S3). Never shifted. */
  sectors: readonly [number, number];
  /** Curated FIA corner apexes as RACING-lap fractions, in lap order. Never shifted. */
  turns: readonly number[];
  furniture: Furniture;
  kit: Kit;
  /** Grandstand livery rotation (three names). */
  standSet: readonly [StandLivery, StandLivery, StandLivery];
  path: CircuitPath;

  // ── optional ──────────────────────────────────────────────────────────────
  /**
   * Where the start/finish line sits, as an INDEX fraction of `path.pts` in
   * source order (`round(startFrac * N)` is the line's node). Absent = 0.
   * Racing-space data is relative to this line.
   */
  startFrac?: number;
  /**
   * The `startFrac` this circuit's racing-space scenery, `dressingExclusions`
   * and corner boards were authored against. Set only where the start line was
   * later corrected, so the line moves and the dressed world stays put. Its
   * presence makes the engine derive `_sceneryShift` (see the module comment).
   * Also an INDEX fraction.
   */
  sceneryStartFrac?: number;
  /** Retired / off-calendar circuit: excluded from the season (`SEASON = LIST.filter(t => !t.classic)`). */
  classic?: true;
  /** Street circuit: street pit bands, street terrain defaults. */
  street?: boolean;
  /** Enables the banking profile (mesh.js `bankingProfile`) even without `bankZones`. */
  banked?: true;
  /** Real GP lap count; absent derives it from the GP distance and `lengthKm`. */
  gpLaps?: number;
  /** Tyre degradation multiplier (tyre-model.js `severity`); absent = 1. */
  tyreSeverity?: number;
  /** Hand-tuned sun azimuth bias (atmosphere.js); absent falls back to a generic bias. */
  sunAzimBias?: number;
  sceneryTheme?: SceneryTheme;
  sceneryThemeOverrides?: SceneryThemeOverrides;
  /** Mirror racing-space scenery on a reversed lap (`TrackSpace.lapMirror`). */
  sceneryLapMirror?: true;
  /** The circuit dresses its own pit straight: suppress the generic pit stands. */
  ownPitStraight?: true;
  dressingExclusions?: readonly DressingExclusion[];
  terrainMat?: TerrainMat;
  /** Outer terrain ribbon width in metres (absent: 28 street, 120 otherwise). */
  terrainOuter?: number;
  /** Start of the opt-in gradual outer terrain descent, metres (>= 30, < terrainOuter). */
  terrainFalloffStart?: number;
  /** Flat outer terrain. */
  flatTerrain?: true;
  /** Barrier offset from the road edge in metres (build-props.js; absent = 0.35). */
  barrierGap?: number;
  /** Authored elevation bumps; ignored when the circuit has surveyed elevations. */
  elevations?: readonly Elevation[];
  bridges?: readonly Bridge[];
  hwZones?: readonly HwZone[];
  bankZones?: readonly BankZone[];
  barrier?: BarrierColours;
  cityStyle?: CityStyle;
  pit?: PitSpec;
  /** `false` opts out of the centreline undulation in buildCenterline. */
  undulate?: boolean;
}
