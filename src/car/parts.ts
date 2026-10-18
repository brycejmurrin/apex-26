// Parts catalog and stat helpers. Twelve upgrade categories; supplier-locked options
// fall back via getMods/getCost; statMult() maps 0–100 team stats to 0.85–1.00;
// visualTier drives Car3D geometry only; SIGNATURE options clone `equivalent` for mesh
// identity — see FACTORY_PRESETS.
//
// apex-26 port of f1-game js/car/parts.js:1-863 (the `Parts` IIFE global), verbatim:
// BUDGET :6, CATALOG :8-570, DEFAULTS :572-577, VISUAL_FIELD_REGISTRY :579-617,
// FACTORY_PRESETS :619-636, teamContext :638-644, the regulation hook :646-677,
// _resolve :678-696, resolveSetup :698-728, tread :730-735, the factory cache
// :737-774, getMods/getCost/statMult :776-786, STAT_KEYS/displayStat :788-805,
// statSpan/spanFraction/ersProfile :807-828, aeroLoad :830-840, getVisualTiers
// :842-852, the export object :855-862.
//
// Deviations:
// - Log.info at load (parts.js:854) is dropped, as in ./car3d.ts. parts.js reads no
//   other global: Teams, SetupTune and CareerAiDev appear only in comments, so there
//   is no optional-dependency bag.
// - The catalog data is copied text for text; only `const` type annotations are added.
//   CATALOG, its options and FACTORY_PRESETS stay unfrozen, as in f1-game; `Parts` is
//   frozen shallowly like parts.js:863.

/** The twelve CATALOG category ids, in catalog order. */
export type CategoryId =
  | "engine" | "aero" | "suspension" | "brakes" | "tyres" | "ers"
  | "gearbox" | "fuel" | "exhaust" | "floor" | "cockpit" | "wheels";

/** The four stat multipliers a part may carry. */
export type StatKey = "speed" | "accel" | "cornering" | "braking";

/** One recipe value in an option's `visual` bag: a scalar, an RGB triple or null. */
export type VisualValue = number | readonly number[] | null;

/** An option's `visual` recipe: field -> value, consumed by car-body-geom / car-wheels
 *  (VISUAL_FIELD_REGISTRY names every field's consumer). */
export type PartVisual = { readonly [field: string]: VisualValue };

/** One CATALOG option (parts.js:15 onward). Absent stats are 1. */
export interface PartOption {
  id: string;
  label: string;
  cost: number;
  desc: string;
  speed?: number;
  accel?: number;
  cornering?: number;
  braking?: number;
  visual?: PartVisual;
  /** 0 | 1 | 2; absent reads as 1 (parts.js:709). */
  visualTier?: number;
  /** "SIGNATURE" | "FACTORY". */
  tag?: string;
  /** Team ids allowed to fit it (SIGNATURE). */
  teams?: readonly string[];
  /** Single-team form isOptionAvailable also accepts (parts.js:670). */
  team?: string;
  /** Engine supplier allowed to fit it (FACTORY power units). */
  supplier?: string;
  suppliers?: readonly string[];
  /** The universal option a locked one falls back to (same cost and stats). */
  equivalent?: string;
  /** Tyre wet tread class: 0 slick, 1 intermediate, 2 full wet. */
  wetTread?: number;
  /** Tyre life multiplier. */
  life?: number;
}

/** One CATALOG category. */
export interface PartCategory {
  id: CategoryId;
  label: string;
  /** Short garage tab label where the label is too long. */
  tab?: string;
  options: PartOption[];
}

/** A full setup: one option id per category. */
export type PartSetupFull = Record<CategoryId, string>;
/** A requested setup: any subset; unknown ids or undefined fall back to DEFAULTS. */
export type PartSetup = { [K in CategoryId]?: string | undefined };

/** The team argument every resolver takes: a team object, or a bare engine-supplier
 *  string (teamContext, parts.js:639). `factory` is a team's own works build (:757). */
export type PartsTeam =
  | string
  | { readonly id?: string | null | undefined; readonly engine?: string | null | undefined; readonly factory?: PartSetup | null | undefined }
  | null
  | undefined;

/** The ownership set isOptionAvailable's third argument reads (`owned.has(id)`). */
export interface OwnedSet { has(id: string): boolean }

/** The SETUP SHEET's contribution (SetupTune.mods / SetupTune.aero). */
export interface PartsTune {
  speed?: number | undefined;
  accel?: number | undefined;
  cornering?: number | undefined;
  braking?: number | undefined;
  /** −1..1 rake, read by aeroLoad only. */
  rake?: number | undefined;
}

/** A career-era legality predicate (truthy = legal). */
export type LegalityFn = (opt: PartOption) => unknown;

export type StatMods = Record<StatKey, number>;

/** One category's resolved visual recipe: `{ id, tier }` plus the option's `visual`. */
export type ResolvedVisual = { readonly id: string; readonly tier: number } & PartVisual;

/** resolveSetup's result (parts.js:727). `ids` is the same object as `setup`. */
export interface ResolvedSetup {
  setup: PartSetupFull;
  mods: StatMods;
  cost: number;
  ids: PartSetupFull;
  tiers: Record<CategoryId, number>;
  visual: Record<CategoryId, ResolvedVisual>;
  options: Record<CategoryId, PartOption>;
}

/** getVisualTiers' result: tier per category plus `_ids` and `_visual` (parts.js:846). */
export type VisualTiers = Record<CategoryId, number> & {
  _ids: PartSetupFull;
  _visual: Record<CategoryId, ResolvedVisual>;
};

export interface StatSpan { lo: number; hi: number }

// 780 is NOT enough to fit a good part everywhere (one top option per
// category totals ~2340), so the spend stays a real trade-off.
const BUDGET = 780;

const CATALOG: PartCategory[] = [
  {
    id: "engine", label: "ENGINE",
    // Every universal rung owns a distinct (chimney, servicePanel, heatShield)
    // cooling package that does not track price, not one body at thirteen
    // scales (which scores `performance` vs `evo_kit` 0.332 on a key
    // distance whose category median is 1.6). Costs and stats untouched.
    options: [
      { id: "stock",        label: "Stock",          cost:   0, desc: "Factory spec power unit",                                           visual: { in: 0.85, inlet: 1, outlet: 1, podWidth: 1, shoulderHeight: 1, undercut: 1, coke: 1, tailWidth: 1, coverHeight: 1, servicePanel: 1, heatShield: 1 }, visualTier: 1 },
      { id: "lean_burn",    label: "Lean Burn",      cost:  35, desc: "Efficiency-tuned mapping — fuel saving with surprising torque",     accel: 1.05, braking: 1.02, visual: {"in": 0.72, "inlet": 0, "outlet": 0, podWidth: 0.88, shoulderHeight: 0.92, undercut: 1.18, coke: 1.15, tailWidth: 0.88, coverHeight: 0.90, chimney: 0, servicePanel: 0, heatShield: 0}, visualTier: 1 },
      { id: "performance",  label: "Performance",    cost:  60, desc: "Optimised mapping — peak acceleration gains",                       accel: 1.09, visual: {"in": 1.15, "twin": 1, "inlet": 2, "outlet": 1, podWidth: 1.08, shoulderHeight: 1.12, undercut: 0.90, coke: 0.94, tailWidth: 1.08, coverHeight: 1.07, chimney: 0, servicePanel: 4, heatShield: 2}, visualTier: 2 },
      { id: "v_power",      label: "V-Power Spec",   cost:  60, desc: "Premium fuel-optimised mapping — balanced speed and accel",        speed: 1.02, accel: 1.07, visual: {"in": 1.1, "twin": 1, "inlet": 2, "outlet": 1, podWidth: 1.04, shoulderHeight: 1.08, undercut: 0.96, coke: 1.02, tailWidth: 1.04, coverHeight: 1.03, chimney: 1, servicePanel: 1, heatShield: 1}, visualTier: 2 },
      { id: "turbo",        label: "Turbo",          cost:  80, desc: "Broader power band — balanced speed and accel",                    speed: 1.04, accel: 1.06, braking: 0.99, visual: {"in": 1.35, "snork": 1, "inlet": 2, "outlet": 2, podWidth: 1.13, shoulderHeight: 1.18, undercut: 0.86, coke: 0.92, tailWidth: 1.12, coverHeight: 1.12, chimney: 2, servicePanel: 2, heatShield: 1}, visualTier: 1 },
      { id: "highrev",      label: "High-Rev",       cost: 115, desc: "High-RPM spec — top speed focus, mild accel gain",                 speed: 1.07, accel: 1.03, braking: 0.98, visual: {"in": 1.25, "snork": 1, "inlet": 3, "outlet": 2, podWidth: 1.06, shoulderHeight: 1.14, undercut: 0.92, coke: 1.08, tailWidth: 0.96, coverHeight: 1.16, chimney: 3, servicePanel: 0, heatShield: 1}, visualTier: 1 },
      { id: "evo_kit",      label: "EVO Kit",        cost: 105, desc: "Engine evolution package — well-rounded gains across all metrics", speed: 1.04, accel: 1.07, cornering: 1.02, braking: 1.02, visual: {"in": 1.2, "twin": 1, "inlet": 2, "outlet": 1, podWidth: 1.10, shoulderHeight: 1.10, undercut: 0.88, coke: 0.98, tailWidth: 1.06, coverHeight: 1.09, chimney: 1, servicePanel: 3, heatShield: 2}, visualTier: 2 },
      { id: "sprint",       label: "Sprint",         cost: 125, desc: "Torque-focused unit — explosive accel, lower top speed",           speed: 0.97, accel: 1.14, visual: {"in": 1.15, "twin": 1, "inlet": 3, "outlet": 2, podWidth: 1.12, shoulderHeight: 1.16, undercut: 0.84, coke: 0.90, tailWidth: 1.10, coverHeight: 1.11, chimney: 0, servicePanel: 3, heatShield: 0}, visualTier: 2 },
      { id: "race",         label: "Race",           cost: 145, desc: "Maximum power output across the rev range",                        speed: 1.06, accel: 1.11, visual: {"in": 1.55, "snork": 1, "twin": 1, "inlet": 3, "outlet": 3, podWidth: 1.16, shoulderHeight: 1.20, undercut: 0.82, coke: 0.88, tailWidth: 1.14, coverHeight: 1.18, chimney: 2, servicePanel: 4, heatShield: 2}, visualTier: 2 },
      { id: "split_turbo",  label: "Split Turbo",    cost: 165, desc: "Separated compressor layout — sharp response with strong terminal speed",   speed: 1.06, accel: 1.13, braking: 1.01, visual: { in: 1.42, snork: 1, twin: 0, inlet: 3, outlet: 2, podWidth: 1.09, shoulderHeight: 1.13, undercut: 1.04, coke: 0.86, tailWidth: 1.02, coverHeight: 1.14, chimney: 2, servicePanel: 1, heatShield: 2}, visualTier: 2 },
      // Manufacturer-exclusive power units — shown only when team.engine matches
      // THE 2026 SILHOUETTES. The engine `visual` of each team's FACTORY_PRESETS
      // unit is the strongest shape lever at race distance (pods ±37 cm a side,
      // undercut, airbox), so those recipes follow the REAL 2026 concepts, not
      // the PU's price tier (2026-10-03; sources in js/data/teams.js): RB22 and
      // AMR26 very tight pods, Audi near zero-pod (vertical inlets), Williams
      // and Alpine wide, Ferrari a compact triangular airbox, Racing Bulls the
      // largest airbox on the grid, Haas a larger hoop inlet than Ferrari.
      // Mesh only: getMods / ersProfile / aeroLoad never read `visual`.
      { id: "manu_mercedes", label: "AMG HPP",        cost: 200, supplier: "Mercedes",      tag: "FACTORY",
        desc: "Mercedes-AMG High Performance Powertrains — 2026 peak spec",                   speed: 1.08, accel: 1.14, visual: {"in": 1.55, "snork": 1, "twin": 1, "inlet": 2, "outlet": 2, podWidth: 0.78, shoulderHeight: 0.96, undercut: 1.28, coke: 1.28, tailWidth: 0.76, coverHeight: 0.94, scoopLip: 2}, visualTier: 2 },
      { id: "manu_ferrari",  label: "Ferrari 066/12", cost: 200, supplier: "Ferrari",       tag: "FACTORY",
        desc: "Scuderia Ferrari power unit — strong top speed and precision braking",          speed: 1.09, accel: 1.11, braking: 1.04, visual: {"in": 1.40, "snork": 1, "twin": 1, "inlet": 3, "outlet": 3, podWidth: 1.06, shoulderHeight: 1.12, undercut: 1.24, coke: 1.12, tailWidth: 0.98, coverHeight: 0.98, scoopLip: 1}, visualTier: 2 },
      { id: "manu_ford",     label: "Ford Powertrains", cost: 200, supplier: "Red Bull Ford", tag: "FACTORY",
        desc: "Ford/Red Bull 2026 unit — explosive torque delivery out of slow corners",       speed: 1.06, accel: 1.16, visual: {"in": 1.40, "snork": 1, "twin": 1, "inlet": 2, "outlet": 2, podWidth: 0.85, shoulderHeight: 0.98, undercut: 1.30, coke: 1.32, tailWidth: 0.78, coverHeight: 0.96, scoopLip: 1}, visualTier: 2 },
      { id: "manu_honda",    label: "Honda RA626H",   cost: 200, supplier: "Honda",         tag: "FACTORY",
        desc: "Honda RA626H — balanced power with exceptional traction assist",                speed: 1.07, accel: 1.12, cornering: 1.04, visual: {"in": 1.32, "snork": 1, "twin": 1, "inlet": 3, "outlet": 3, podWidth: 0.74, shoulderHeight: 0.94, undercut: 1.38, coke: 1.32, tailWidth: 0.78, coverHeight: 1.02, scoopLip: 1}, visualTier: 2 },
      { id: "manu_audi",     label: "Audi P.U.",      cost: 200, supplier: "Audi",          tag: "FACTORY",
        desc: "Audi 2026 power unit — strong braking recovery and mid-range punch",            speed: 1.07, accel: 1.12, braking: 1.06, visual: {"in": 1.48, "snork": 1, "twin": 1, "inlet": 2, "outlet": 2, podWidth: 0.76, shoulderHeight: 0.92, undercut: 1.28, coke: 1.30, tailWidth: 0.76, coverHeight: 1.12, scoopLip: 2}, visualTier: 2 },
      // Non-exclusive upgrades above factory level
      { id: "torque_curve",  label: "Torque Curve",  cost:  40, desc: "Rebalanced mapping — strong traction out of slow corners",        accel: 1.06, cornering: 1.03, visual: {"in": 1.0, "inlet": 1, "outlet": 1, podWidth: 0.98, shoulderHeight: 1.04, undercut: 1.02, coke: 1.06, tailWidth: 0.95, coverHeight: 1.00, chimney: 0, servicePanel: 2, heatShield: 1}, visualTier: 1 },
      { id: "hybrid_max",    label: "Hybrid Max",    cost: 150, desc: "Full MGU-K/H synergy — broad power gains across all four metrics", speed: 1.05, accel: 1.08, cornering: 1.03, braking: 1.02, visual: {"in": 1.3, "snork": 1, "twin": 1, "inlet": 2, "outlet": 2, podWidth: 1.08, shoulderHeight: 1.15, undercut: 0.89, coke: 0.95, tailWidth: 1.06, coverHeight: 1.13, chimney: 1, servicePanel: 2, heatShield: 0}, visualTier: 2 },
      { id: "sig_mercedes_zero", label: "Downwash PU", cost: 150, teams: ["mercedes"], tag: "SIGNATURE", equivalent: "hybrid_max",
        desc: "Mercedes signature compact installation — Hybrid Max performance in a tighter cooling form", speed: 1.05, accel: 1.08, cornering: 1.03, braking: 1.02, visual: { in: 1.40, snork: 1, twin: 1, inlet: 2, outlet: 3, podWidth: 0.90, shoulderHeight: 0.94, undercut: 1.22, coke: 1.18, tailWidth: 0.84, coverHeight: 0.92 , scoopLip: 2}, visualTier: 2 },
      { id: "quali_engine",  label: "Quali Mode",    cost: 195, desc: "Unrestricted qualifying spec — peak power, no thermal limits",    speed: 1.10, accel: 1.09, braking: 0.97, visual: {"in": 1.65, "snork": 1, "twin": 1, "inlet": 3, "outlet": 3, podWidth: 1.20, shoulderHeight: 1.24, undercut: 0.78, coke: 0.84, tailWidth: 1.18, coverHeight: 1.22, chimney: 3, servicePanel: 4, heatShield: 2}, visualTier: 2 },
      // Cooling-layout units — the `chimney` stacks are the visual tell.
      { id: "chimney_spec",  label: "Chimney Spec",  cost:  90, desc: "Open-cooling installation — runs hot mappings safely for strong acceleration", speed: 1.01, accel: 1.08, braking: 1.03, visual: { in: 1.22, snork: 0, twin: 0, inlet: 2, outlet: 2, podWidth: 1.03, shoulderHeight: 1.05, undercut: 0.97, coke: 1.05, tailWidth: 1.01, coverHeight: 1.06, chimney: 3 }, visualTier: 1 },
      { id: "sealed_pod",    label: "Sealed Bodywork", cost: 95, desc: "Fully closed cooling — minimum drag from a tightly packaged installation", speed: 1.06, accel: 1.02, visual: { in: 0.96, snork: 0, twin: 0, inlet: 1, outlet: 1, podWidth: 0.84, shoulderHeight: 0.94, undercut: 1.22, coke: 1.20, tailWidth: 0.82, coverHeight: 0.96, chimney: 0 }, visualTier: 1 },
      { id: "plenum_max",    label: "Plenum Max",    cost: 155, desc: "Oversized airbox plenum — deep breathing across the whole rev range",   speed: 1.08, accel: 1.08, braking: 0.98, visual: { in: 1.72, snork: 1, twin: 1, inlet: 3, outlet: 2, podWidth: 1.11, shoulderHeight: 1.21, undercut: 0.85, coke: 0.96, tailWidth: 1.09, coverHeight: 1.19, chimney: 1 }, visualTier: 2 },
      { id: "sig_mclaren_pu", label: "Woking Hybrid", cost: 150, teams: ["mclaren"], tag: "SIGNATURE", equivalent: "hybrid_max",
        desc: "McLaren signature hybrid — Hybrid Max performance with 1 cooling chimney", speed: 1.05, accel: 1.08, cornering: 1.03, braking: 1.02, visual: { in: 1.3, snork: 1, twin: 1, inlet: 2, outlet: 2, podWidth: 1.00, shoulderHeight: 1.08, undercut: 1.08, coke: 1.06, tailWidth: 0.96, coverHeight: 1.00, chimney: 1 , scoopLip: 1}, visualTier: 2 },
      { id: "sig_alpine_pu", label: "Enstone Hybrid", cost: 60, teams: ["alpine"], tag: "SIGNATURE", equivalent: "performance",
        desc: "Alpine signature hybrid — Performance spec with 3 cooling chimneys", speed: 1.00, accel: 1.09, visual: { in: 1.30, twin: 1, inlet: 2, outlet: 1, podWidth: 1.24, shoulderHeight: 1.16, undercut: 0.84, coke: 0.90, tailWidth: 1.16, coverHeight: 1.081, chimney: 3 , scoopLip: 1}, visualTier: 2 },
      { id: "sig_racingbulls_pu", label: "Faenza Hybrid", cost: 40, teams: ["racingbulls"], tag: "SIGNATURE", equivalent: "torque_curve",
        desc: "Racing Bulls signature hybrid — Torque Curve performance with 1 cooling chimney", accel: 1.06, cornering: 1.03, visual: { in: 1.62, inlet: 1, outlet: 1, podWidth: 0.92, shoulderHeight: 1.003, undercut: 1.10, coke: 1.145, tailWidth: 0.904, coverHeight: 0.97, chimney: 1 , scoopLip: 1}, visualTier: 1 },
      { id: "sig_haas_pu", label: "Kannapolis Hybrid", cost: 60, teams: ["haas"], tag: "SIGNATURE", equivalent: "v_power",
        desc: "Haas signature hybrid — V-Power Spec performance with 2 cooling chimneys", speed: 1.02, accel: 1.07, visual: { in: 1.45, twin: 1, inlet: 2, outlet: 1, podWidth: 1.10, shoulderHeight: 1.145, undercut: 0.96, coke: 0.959, tailWidth: 1.08, coverHeight: 1.082, chimney: 2 , scoopLip: 1}, visualTier: 2 },
      { id: "sig_williams_pu", label: "Grove Hybrid", cost: 115, teams: ["williams"], tag: "SIGNATURE", equivalent: "highrev",
        desc: "Williams signature hybrid — High-Rev performance with fully sealed cooling bodywork", speed: 1.07, accel: 1.03, braking: 0.98, visual: { in: 1.25, snork: 1, inlet: 3, outlet: 2, podWidth: 1.20, shoulderHeight: 1.18, undercut: 0.86, coke: 0.98, tailWidth: 1.08, coverHeight: 1.079, chimney: 0 , scoopLip: 1}, visualTier: 1 },
      { id: "sig_cadillac_pu", label: "Detroit Hybrid", cost: 200, teams: ["cadillac"], tag: "SIGNATURE", equivalent: "manu_ferrari",
        desc: "Cadillac signature hybrid — Ferrari 066/12 performance with 3 cooling chimneys", speed: 1.09, accel: 1.11, braking: 1.04, visual: { in: 1.40, snork: 1, twin: 1, inlet: 3, outlet: 3, podWidth: 1.04, shoulderHeight: 1.10, undercut: 1.02, coke: 1.00, tailWidth: 1.04, coverHeight: 1.10, chimney: 3 , scoopLip: 2}, visualTier: 2 },
    ],
  },
  {
    id: "aero", label: "AERO",
    options: [
      { id: "minimal",       label: "Minimal",        cost:   0, desc: "+10% top speed — heavily reduced downforce",                     speed: 1.10, accel: 0.96, cornering: 0.78, visual: {lvl: 0, vane: 0, beam: 0, drs: 1, board: 1, frontSweep: -0.03, frontTaper: 1.05, frontRise: 0, rearSweep: -0.02, rearTaper: 1.04, floorEdge: 0.78, floorCut: 0.02, diffuserRise: 0.72, fin: 0.6}, visualTier: 0 },
      { id: "le_mans",       label: "Le Mans Trim",   cost:  80, desc: "Hypercar ultra-low drag — extreme top speed, severe grip penalty", speed: 1.14, accel: 0.94, cornering: 0.80, braking: 0.98, visual: {gill: 0, lvl: 0, vane: 1, beam: 0, drs: 1, board: 1, frontSweep: 0.01, frontTaper: 0.94, frontRise: 0.01, rearSweep: 0.02, rearTaper: 0.9, floorEdge: 0.82, floorCut: 0.08, diffuserRise: 0.76, fin: 0.72}, visualTier: 0 },
      { id: "low",           label: "Low DF",         cost:  10, desc: "+6% top speed — reduced cornering grip",                         speed: 1.06, accel: 0.98, cornering: 0.88, visual: {lvl: 1, vane: 1, beam: 0, drs: 1, board: 1, frontSweep: 0.03, frontTaper: 0.96, frontRise: 0.02, rearSweep: 0.04, rearTaper: 0.94, floorEdge: 0.88, floorCut: 0.06, diffuserRise: 0.82, fin: 0.8}, visualTier: 0 },
      { id: "s_duct",        label: "S-Duct",         cost:  30, desc: "Shaped duct package — front aero efficiency with grip trade-off", speed: 1.04, cornering: 0.93, braking: 1.02, visual: {lvl: 1, vane: 2, beam: 0, drs: 1, board: 1, frontSweep: 0.08, frontTaper: 0.92, frontRise: 0.05, rearSweep: 0.03, rearTaper: 0.96, floorEdge: 0.9, floorCut: 0.1, diffuserRise: 0.84, fin: 0.9}, visualTier: 0 },
      { id: "medium",        label: "Medium",         cost:   0, desc: "Balanced configuration for all circuit types",                   visual: { lvl: 2, vane: 1, beam: 0, drs: 1, board: 1, frontSweep: 0.04, frontTaper: 0.98, frontRise: 0.04, rearSweep: 0.03, rearTaper: 0.98, floorEdge: 1.00, floorCut: 0.04, diffuserRise: 1.00 }, visualTier: 1 },
      // beam_wing keeps beam:1 as the career/fantasy exception (#1198); flaps + bargeboard still 2026.
      { id: "beam_wing",     label: "Beam Wing",      cost:  75, desc: "Rear beam wing — cornering and braking from low-drag base",      speed: 0.99, accel: 1.05, cornering: 1.07, braking: 1.04, visual: {arch: 1, lvl: 2, beam: 1, drs: 1, board: 1, vane: 1, frontSweep: 0.04, frontTaper: 0.97, frontRise: 0.04, rearSweep: 0.07, rearTaper: 0.93, floorEdge: 0.98, floorCut: 0.05, diffuserRise: 1.06, fin: 1.12}, visualTier: 2 },
      { id: "rake_setup",    label: "Rake Setup",     cost:  90, desc: "High-rear rake — improved cornering and braking",                speed: 0.97, accel: 1.02, cornering: 1.10, braking: 1.08, visual: {lvl: 3, vane: 2, beam: 0, drs: 1, board: 1, frontSweep: 0.06, frontTaper: 0.94, frontRise: 0.07, rearSweep: 0.08, rearTaper: 0.94, floorEdge: 1.04, floorCut: 0.11, diffuserRise: 1.12, fin: 1.2}, visualTier: 2 },
      { id: "diffuser",      label: "Diffuser Focus", cost: 110, desc: "Rear diffuser package — cornering and braking bias",             speed: 0.98, accel: 1.04, cornering: 1.18, braking: 1.06, visual: {lvl: 3, beam: 0, drs: 1, board: 1, vane: 2, frontSweep: 0.05, frontTaper: 0.96, frontRise: 0.06, rearSweep: 0.07, rearTaper: 0.92, floorEdge: 1.1, floorCut: 0.14, diffuserRise: 1.28, fin: 1.05}, visualTier: 2 },
      { id: "high",          label: "High DF",        cost:  65, desc: "−5% top speed, strong cornering grip",                          speed: 0.95, accel: 0.99, cornering: 1.15, visual: {lvl: 3.25, vane: 2, beam: 0, drs: 1, board: 1, frontSweep: 0.08, frontTaper: 0.91, frontRise: 0.09, rearSweep: 0.09, rearTaper: 0.9, floorEdge: 1.08, floorCut: 0.1, diffuserRise: 1.16, fin: 1.28}, visualTier: 2 },
      { id: "underfloor",    label: "Underfloor Kit", cost: 115, desc: "Enhanced tunnel floors — high grip with less drag penalty",      speed: 0.94, accel: 1.05, cornering: 1.22, visual: {lvl: 3, beam: 0, drs: 1, board: 1, vane: 3, frontSweep: 0.07, frontTaper: 0.93, frontRise: 0.08, rearSweep: 0.06, rearTaper: 0.94, floorEdge: 1.24, floorCut: 0.18, diffuserRise: 1.26, fin: 0.86}, visualTier: 2 },
      { id: "extreme",       label: "Extreme DF",     cost: 130, desc: "Maximum downforce — Monaco / Singapore spec",                   speed: 0.89, accel: 0.96, cornering: 1.28, braking: 1.06, visual: {lvl: 4, vane: 3, beam: 0, drs: 1, board: 1, frontSweep: 0.12, frontTaper: 0.86, frontRise: 0.14, rearSweep: 0.12, rearTaper: 0.86, floorEdge: 1.18, floorCut: 0.16, diffuserRise: 1.3, fin: 1.42}, visualTier: 2 },
      { id: "active_aero",   label: "Active Aero",    cost: 160, desc: "Adaptive aero surfaces — speed and cornering in one package",    speed: 1.03, accel: 1.03, cornering: 1.18, visual: {lvl: 3, beam: 0, drs: 1, board: 1, vane: 2, frontSweep: 0.1, frontTaper: 0.9, frontRise: 0.1, rearSweep: 0.14, rearTaper: 0.88, floorEdge: 1.06, floorCut: 0.12, diffuserRise: 1.14, fin: 1.34}, visualTier: 2 },
      { id: "ground_effect", label: "Ground Effect",  cost: 170, desc: "2026 tunnel floor package — peak grip and braking",              speed: 0.87, accel: 1.08, cornering: 1.32, braking: 1.10, visual: {lvl: 4, beam: 0, drs: 1, vane: 3, board: 1, frontSweep: 0.09, frontTaper: 0.89, frontRise: 0.11, rearSweep: 0.1, rearTaper: 0.88, floorEdge: 1.3, floorCut: 0.22, diffuserRise: 1.36, fin: 0.95}, visualTier: 2 },
      { id: "circuit_adaptive", label: "Circuit Adaptive", cost: 190, desc: "Linked flap and floor package — efficient grip across mixed-speed sectors", speed: 1.01, accel: 1.05, cornering: 1.22, braking: 1.06, visual: {lvl: 3.6, beam: 0, drs: 1, vane: 3, board: 1, frontSweep: 0.11, frontTaper: 0.88, frontRise: 0.12, rearSweep: 0.13, rearTaper: 0.87, floorEdge: 1.16, floorCut: 0.15, diffuserRise: 1.22, fin: 1.18}, visualTier: 2 },
      { id: "sig_mclaren_flex", label: "Papaya Flex Wing", cost: 190, teams: ["mclaren"], tag: "SIGNATURE", equivalent: "circuit_adaptive",
        desc: "McLaren signature compliant flap package — Circuit Adaptive performance with a twin-vane form and a slim upper duct", speed: 1.01, accel: 1.05, cornering: 1.22, braking: 1.06, visual: {lvl: 3.55, beam: 0, drs: 1, vane: 2, plate: 1, casc: 2, swan: 0, tvane: 0, duct: 1, board: 1, slot: 0, frontSweep: 0.15, frontTaper: 0.84, frontRise: 0.13, rearSweep: 0.16, rearTaper: 0.84, floorEdge: 1.14, floorCut: 0.17, diffuserRise: 1.2, fin: 1.36}, visualTier: 2 },
      { id: "sig_williams_lowdrag", label: "Grove Low-Drag", cost: 10, teams: ["williams"], tag: "SIGNATURE", equivalent: "low",
        desc: "Williams signature straight-line package — Low DF performance with active flaps and an in-wash bargeboard", speed: 1.06, accel: 0.98, cornering: 0.88, visual: {lvl: 1.15, vane: 0, beam: 0, drs: 1, board: 1, frontSweep: -0.02, frontTaper: 1.02, frontRise: 0.01, rearSweep: 0.01, rearTaper: 0.92, floorEdge: 0.86, floorCut: 0.03, diffuserRise: 0.8, fin: 0.65}, visualTier: 0 },
      { id: "sig_aston_tunnel", label: "Silverstone Tunnel", cost: 170, teams: ["astonmartin"], tag: "SIGNATURE", equivalent: "ground_effect",
        desc: "Aston Martin signature tunnel floor — Ground Effect performance with an active upper flap and floor-corner slots", speed: 0.87, accel: 1.08, cornering: 1.32, braking: 1.10, visual: {arch: 1, gill: 2, lvl: 4, beam: 0, vane: 2, drs: 1, plate: 1, casc: 2, swan: 0, tvane: 1, duct: 0, board: 2, slot: 1, frontSweep: 0.1, frontTaper: 0.87, frontRise: 0.12, rearSweep: 0.15, rearTaper: 0.82, floorEdge: 1.32, floorCut: 0.21, diffuserRise: 1.38, fin: 1.08}, visualTier: 2 },
      { id: "sig_redbull_concept", label: "Newey Concept", cost: 185, teams: ["redbull"], tag: "SIGNATURE", equivalent: "reg26_concept",
        desc: "Red Bull signature high-rake concept — 2026 Concept performance with active flaps, a wakeboard and floor-corner slots", speed: 0.93, accel: 1.10, cornering: 1.24, braking: 1.08, visual: {lvl: 4, beam: 0, drs: 1, vane: 3, plate: 2, casc: 2, swan: 1, tvane: 0, duct: 0, board: 2, slot: 1, frontSweep: 0.08, frontTaper: 0.9, frontRise: 0.14, rearSweep: 0.11, rearTaper: 0.87, floorEdge: 1.26, floorCut: 0.19, diffuserRise: 1.44, fin: 1.44}, visualTier: 2 },
      { id: "swan_low",      label: "Swan-Neck Low Drag", cost: 25, desc: "Over-slung wing mount on a stripped front end — clean airflow, minimal downforce", speed: 1.07, accel: 0.99, cornering: 0.86, visual: {lvl: 1, vane: 1, plate: 0, casc: 0, swan: 1, tvane: 0, beam: 0, drs: 1, board: 1, frontSweep: 0.02, frontTaper: 0.99, frontRise: 0.01, rearSweep: 0.05, rearTaper: 0.92, floorEdge: 0.9, floorCut: 0.05, diffuserRise: 0.86, fin: 0.68}, visualTier: 0 },
      { id: "outwash_max",   label: "Max Outwash",   cost: 140, desc: "Tall arched endplates and a full canard cascade — front-end bite in slow corners", speed: 0.96, accel: 0.98, cornering: 1.24, braking: 1.08, visual: {arch: 1, gill: 4, lvl: 3, vane: 2, plate: 3, casc: 3, swan: 0, tvane: 0, beam: 0, drs: 1, board: 1, frontSweep: 0.14, frontTaper: 0.85, frontRise: 0.13, rearSweep: 0.06, rearTaper: 0.95, floorEdge: 1.12, floorCut: 0.13, diffuserRise: 1.18, fin: 1.38}, visualTier: 2 },
      { id: "twin_tier",     label: "Twin-Tier Wing", cost: 130, desc: "Swan-neck rear with a T-wing tier — stable rear platform through fast sequences", speed: 0.97, accel: 1.04, cornering: 1.22, braking: 1.03, visual: {gill: 2, lvl: 3, beam: 0, drs: 1, board: 1, vane: 2, plate: 1, casc: 2, swan: 1, tvane: 1, frontSweep: 0.07, frontTaper: 0.92, frontRise: 0.07, rearSweep: 0.11, rearTaper: 0.89, floorEdge: 1.08, floorCut: 0.12, diffuserRise: 1.2, fin: 1.25}, visualTier: 2 },
      { id: "sig_cadillac_lowline", label: "Detroit Lowline", cost: 80, teams: ["cadillac"], tag: "SIGNATURE", equivalent: "le_mans",
        desc: "Cadillac signature superspeedway trim — Le Mans Trim performance with active flaps, a letterbox duct and an in-wash bargeboard", speed: 1.14, accel: 0.94, cornering: 0.80, braking: 0.98, visual: {lvl: 0, vane: 0, beam: 0, drs: 1, plate: 0, casc: 0, swan: 0, tvane: 0, duct: 1, board: 1, slot: 0, frontSweep: -0.02, frontTaper: 1.04, frontRise: 0, rearSweep: 0.01, rearTaper: 0.94, floorEdge: 0.84, floorCut: 0.04, diffuserRise: 0.74, fin: 0.7}, visualTier: 0 },
      { id: "wake_board", label: "Wakeboard Kit", cost: 110, desc: "In-wash floor board ahead of the sidepod — 2026 bargeboard return for mid-speed bite", speed: 0.98, accel: 1.07, cornering: 1.14, braking: 1.03, visual: {lvl: 2, vane: 2, plate: 1, casc: 1, swan: 0, tvane: 0, duct: 0, board: 2, slot: 0, beam: 0, drs: 1, frontSweep: 0.05, frontTaper: 0.96, frontRise: 0.05, rearSweep: 0.04, rearTaper: 0.96, floorEdge: 1.06, floorCut: 0.08, diffuserRise: 1.08, fin: 1.15}, visualTier: 2 },
      { id: "pod_duct", label: "Upper Duct", cost: 95, desc: "Top-of-sidepod ram — the optional 2026 cooling duct, cleaner than a wide scoop", speed: 1.03, accel: 1.02, cornering: 1.06, visual: {lvl: 2, vane: 1, plate: 1, casc: 1, swan: 0, tvane: 0, duct: 2, board: 1, slot: 0, beam: 0, drs: 1, frontSweep: 0.03, frontTaper: 0.99, frontRise: 0.03, rearSweep: 0.02, rearTaper: 0.99, floorEdge: 0.96, floorCut: 0.05, diffuserRise: 0.94, fin: 0.78}, visualTier: 1 },
      { id: "reg26_concept", label: "2026 Concept", cost: 185, desc: "Full 2026 body kit — scooped duct, wakeboard and floor-corner slots on a high-DF stack", speed: 0.93, accel: 1.10, cornering: 1.24, braking: 1.08, visual: {arch: 1, gill: 3, lvl: 3.4, beam: 0, drs: 1, vane: 2, plate: 3, casc: 2, swan: 1, tvane: 1, duct: 2, board: 2, slot: 1, frontSweep: 0.1, frontTaper: 0.88, frontRise: 0.11, rearSweep: 0.1, rearTaper: 0.88, floorEdge: 1.2, floorCut: 0.16, diffuserRise: 1.26, fin: 1.3}, visualTier: 2 },
      { id: "sig_mercedes_wing", label: "Brackley Aero Kit", cost: 65, teams: ["mercedes"], tag: "SIGNATURE", equivalent: "high",
        desc: "Mercedes signature aero kit — High DF performance with active flaps, a scooped upper duct and an in-wash bargeboard", speed: 0.95, accel: 0.99, cornering: 1.15, visual: {lvl: 3.25, beam: 0, drs: 1, vane: 2, frontSweep: 0.07, frontTaper: 0.928, frontRise: 0.09, rearSweep: 0.084, rearTaper: 0.918, floorEdge: 1.037, floorCut: 0.1, diffuserRise: 1.114, plate: 1, casc: 1, swan: 1, tvane: 0, duct: 2, board: 1, slot: 0, fin: 1.22}, visualTier: 2 },
      { id: "sig_ferrari_wing", label: "Maranello Aero Kit", cost: 190, teams: ["ferrari"], tag: "SIGNATURE", equivalent: "circuit_adaptive",
        desc: "Ferrari signature aero kit — Circuit Adaptive performance with a full wakeboard and floor-corner slots", speed: 1.01, accel: 1.05, cornering: 1.22, braking: 1.06, visual: {arch: 1, gill: 4, lvl: 3.6, beam: 0, drs: 1, vane: 3, frontSweep: 0.124, frontTaper: 0.845, frontRise: 0.12, rearSweep: 0.138, rearTaper: 0.835, floorEdge: 1.206, floorCut: 0.15, diffuserRise: 1.293, plate: 3, casc: 3, swan: 0, tvane: 1, duct: 0, board: 2, slot: 1, fin: 1.4}, visualTier: 2 },
      { id: "sig_alpine_wing", label: "Enstone Aero Kit", cost: 115, teams: ["alpine"], tag: "SIGNATURE", equivalent: "underfloor",
        desc: "Alpine signature aero kit — Underfloor Kit performance with active flaps, a wakeboard and a T-wing tier", speed: 0.94, accel: 1.05, cornering: 1.22, visual: {lvl: 3, beam: 0, drs: 1, vane: 3, frontSweep: 0.078, frontTaper: 0.93, frontRise: 0.08, rearSweep: 0.065, rearTaper: 0.94, floorEdge: 1.265, floorCut: 0.18, diffuserRise: 1.31, plate: 1, casc: 1, swan: 0, tvane: 1, duct: 0, board: 2, slot: 0, fin: 0.88}, visualTier: 2 },
      { id: "sig_racingbulls_wing", label: "Faenza Aero Kit", cost: 110, teams: ["racingbulls"], tag: "SIGNATURE", equivalent: "wake_board",
        desc: "Racing Bulls signature aero kit — Wakeboard Kit performance with active flaps and a slim upper duct on a swan-neck mount", speed: 0.98, accel: 1.07, cornering: 1.14, braking: 1.03, visual: {lvl: 2, beam: 0, drs: 1, vane: 1, frontSweep: 0.044, frontTaper: 1.009, frontRise: 0.04, rearSweep: 0.072, rearTaper: 0.967, floorEdge: 0.921, floorCut: 0.05, diffuserRise: 0.996, plate: 0, casc: 1, swan: 1, tvane: 0, duct: 1, board: 1, slot: 0, fin: 1.16}, visualTier: 2 },
      { id: "sig_haas_wing", label: "Kannapolis Aero Kit", cost: 10, teams: ["haas"], tag: "SIGNATURE", equivalent: "low",
        desc: "Haas signature aero kit — Low DF performance with active flaps and an in-wash bargeboard", speed: 1.06, accel: 0.98, cornering: 0.88, visual: {lvl: 1, vane: 1, beam: 0, drs: 1, board: 1, frontSweep: 0.016, frontTaper: 1.018, frontRise: 0.02, rearSweep: 0.032, rearTaper: 0.996, floorEdge: 0.95, floorCut: 0.06, diffuserRise: 0.804, plate: 0, casc: 0, swan: 0, tvane: 0, duct: 0, slot: 0, fin: 0.75}, visualTier: 0 },
      { id: "sig_audi_wing", label: "Neuburg Aero Kit", cost: 90, teams: ["audi"], tag: "SIGNATURE", equivalent: "rake_setup",
        desc: "Audi signature aero kit — Rake Setup performance with active flaps, a letterbox duct and wakeboard", speed: 0.97, accel: 1.02, cornering: 1.10, braking: 1.08, visual: {lvl: 3, beam: 0, drs: 1, vane: 2, frontSweep: 0.07, frontTaper: 0.912, frontRise: 0.07, rearSweep: 0.086, rearTaper: 0.912, floorEdge: 1.092, floorCut: 0.11, diffuserRise: 1.21, plate: 2, casc: 2, swan: 0, tvane: 1, duct: 1, board: 1, slot: 0, fin: 1.31}, visualTier: 2 },
    ],
  },
  {
    // `tab` is the GARAGE TAB's label, used only when the full one does not
    // fit it. SUSPENSION is the widest category name and the compact tab rail
    // is a fixed 2-row grid whose columns shrink as the roster grows — at
    // 852x393 it needs 46px of an 8px-font label in a 40px tab and ellipsised
    // to "SUSPENS…". `label` stays the real name: the garage scene board
    // (js/garage/scene.js) and the agent readout both print it.
    id: "suspension", label: "SUSPENSION", tab: "SUSP",
    options: [
      { id: "comfort",         label: "Comfort",         cost:   0, desc: "Softer springs — forgiving over kerbs, less cornering bite",            accel: 1.02, cornering: 0.94, braking: 0.98, visual: {"ride": 0.055, "arm": 0.8, "push": 0}, visualTier: 0 },
      { id: "standard",        label: "Standard",        cost:   0, desc: "Factory road setup",                                                    visual: { ride: 0, arm: 1, push: 0, wishbone: 1, toe: 1 }, visualTier: 1 },
      { id: "sport",           label: "Sport",           cost:  45, desc: "Stiffer setup — improved cornering response",                            accel: 0.99, cornering: 1.08, braking: 1.02, visual: {ride: -0.01, arm: 1.05, push: 0, rocker: 1, wishbone: 1.08}, visualTier: 2 },
      { id: "carbon_pushrods", label: "Carbon Pushrods", cost:  55, desc: "Lightweight carbon arms — quick response and braking benefit",           accel: 1.01, cornering: 1.09, braking: 1.04, visual: {"ride": -0.015, "arm": 0.9, "push": 1}, visualTier: 2 },
      { id: "kerb_spec",       label: "Kerb Spec",       cost:  70, desc: "Circuit-tuned stiffness — helps cornering and braking",                  accel: 1.02, cornering: 1.11, braking: 1.05, visual: {ride: 0.01, arm: 1.1, push: 0, pull: 1, wishbone: 0.9}, visualTier: 2 },
      { id: "low_ride",        label: "Low Ride Height", cost:  75, desc: "Reduced ride height — better aero efficiency and grip",                  speed: 1.02, accel: 0.99, cornering: 1.12, visual: {"ride": -0.035, "arm": 1.05, "push": 0}, visualTier: 2 },
      { id: "racing",          label: "Racing",          cost:  85, desc: "Track-focused — high lateral grip",                                      accel: 0.98, cornering: 1.16, braking: 1.02, visual: {"ride": -0.025, "arm": 1.15, "push": 1, rocker: 1, heave: 1}, visualTier: 2 },
      { id: "triple_damper",   label: "Triple Damper",   cost: 100, desc: "Three-stage damper system — precise compliance across all corner phases", speed: 1.01, accel: 1.02, cornering: 1.17, braking: 1.03, visual: {"ride": -0.02, "arm": 1.2, "push": 1}, visualTier: 2 },
      { id: "titanium_spring", label: "Titanium Spring", cost: 110, desc: "Ultra-light titanium coils — mass reduction with stiffer cornering",     accel: 1.04, cornering: 1.19, visual: {"ride": -0.02, "arm": 0.85, "push": 1, "pull": 1, heave: 1}, visualTier: 2 },
      { id: "inboard_dampers", label: "Inboard Dampers", cost: 160, desc: "Unsprung mass reduction — responsive handling and consistent braking",   accel: 1.02, cornering: 1.18, braking: 1.07, visual: {"ride": -0.02, "arm": 1.1, "push": 1, "pull": 1}, visualTier: 2 },
      { id: "track",           label: "Track",           cost: 145, desc: "Extreme stiffness — maximum cornering",                                  accel: 0.97, cornering: 1.24, braking: 1.02, visual: {"ride": -0.04, "arm": 1.3, "push": 1, heave: 1}, visualTier: 2 },
      { id: "heave_spring",    label: "Heave Spring",    cost: 145, desc: "Aero-optimised springing — stable floor clearance under hard braking",   speed: 1.03, cornering: 1.21, visual: {"ride": -0.03, "arm": 1.2, "push": 1, "pull": 1, rocker: 2, heave: 1}, visualTier: 2 },
      { id: "active",          label: "Active",          cost: 190, desc: "Active suspension system — peak cornering, slight top speed boost",       speed: 1.02, accel: 1.04, cornering: 1.28, braking: 1.03, visual: {"ride": -0.045, "arm": 1.25, "push": 1, rocker: 2, heave: 1}, visualTier: 2 },
      { id: "interlinked",     label: "Interlinked",     cost: 170, desc: "Hydraulically linked heave control — stable platform with kerb compliance", speed: 1.01, accel: 1.02, cornering: 1.23, braking: 1.05, visual: { ride: -0.028, arm: 1.12, push: 1, pull: 1, rocker: 1 }, visualTier: 2 },
      { id: "torsion_bar",     label: "Torsion Bar",     cost:  60, desc: "Torsion-bar springing — compact, consistent response over a long stint",     cornering: 1.11, braking: 1.01, visual: { ride: -0.005, arm: 0.96, push: 0, wishbone: 1.12, toe: 1.08 }, visualTier: 2 },
      { id: "zero_keel",       label: "Zero Keel",       cost:  85, desc: "Keel-less front end — cleaner airflow under the nose with a stiffer platform", speed: 1.02, cornering: 1.13, braking: 1.03, visual: { ride: -0.022, arm: 1.02, push: 1, wishbone: 0.82, toe: 0.92, rocker: 1 , heave: 1}, visualTier: 2 },
      { id: "mono_damper",     label: "Monotube Damper", cost: 130, desc: "Monotube gas dampers — precise control with a useful mass saving",          accel: 1.03, cornering: 1.20, braking: 1.04, visual: { ride: -0.032, arm: 1.06, push: 1, pull: 1, wishbone: 1.24, toe: 1.16, rocker: 2 , heave: 1}, visualTier: 2 },
      { id: "sig_redbull_pullrod", label: "Milton Keynes Pullrod", cost: 190, teams: ["redbull"], tag: "SIGNATURE", equivalent: "active",
        desc: "Red Bull signature pullrod layout — Active performance with a distinct crossed actuator", speed: 1.02, accel: 1.04, cornering: 1.28, braking: 1.03, visual: { ride: -0.043, arm: 1.28, push: 1, pull: 1, rocker: 0 , heave: 1}, visualTier: 2 },
      { id: "sig_mclaren_active", label: "Woking Active", cost: 190, teams: ["mclaren"], tag: "SIGNATURE", equivalent: "active",
        desc: "McLaren signature adaptive platform — Active performance with slimline carbon arms", speed: 1.02, accel: 1.04, cornering: 1.28, braking: 1.03, visual: { ride: -0.047, arm: 0.92, push: 1, pull: 1, rocker: 2 , heave: 1}, visualTier: 2 },
      { id: "sig_audi_damper", label: "Neuburg Damper", cost: 100, teams: ["audi"], tag: "SIGNATURE", equivalent: "triple_damper",
        desc: "Audi signature three-stage damper — Triple Damper performance with a heavy-gauge arm set", speed: 1.01, accel: 1.02, cornering: 1.17, braking: 1.03, visual: { ride: -0.017, arm: 1.32, push: 1, rocker: 2 }, visualTier: 2 },
      { id: "sig_mercedes_susp", label: "Brackley Chassis", cost: 170, teams: ["mercedes"], tag: "SIGNATURE", equivalent: "interlinked",
        desc: "Mercedes signature chassis — Interlinked performance with a crossed pullrod actuator", speed: 1.01, accel: 1.02, cornering: 1.23, braking: 1.05, visual: { ride: -0.024, arm: 1.053, push: 1, pull: 1, wishbone: 1.06, toe: 0.94, rocker: 2 , heave: 1}, visualTier: 2 },
      { id: "sig_ferrari_susp", label: "Maranello Chassis", cost: 85, teams: ["ferrari"], tag: "SIGNATURE", equivalent: "racing",
        desc: "Ferrari signature chassis — Racing performance with pushrod actuation", accel: 0.98, cornering: 1.16, braking: 1.02, visual: { ride: -0.029, arm: 1.265, push: 1, wishbone: 0.9, toe: 1.1, rocker: 1 }, visualTier: 2 },
      { id: "sig_alpine_susp", label: "Enstone Chassis", cost: 70, teams: ["alpine"], tag: "SIGNATURE", equivalent: "kerb_spec",
        desc: "Alpine signature chassis — Kerb Spec performance with heavy-gauge arms", accel: 1.02, cornering: 1.11, braking: 1.05, visual: { ride: 0.012, arm: 1.144, push: 0, wishbone: 0.96, toe: 1.04, rocker: 1 }, visualTier: 2 },
      { id: "sig_racingbulls_susp", label: "Faenza Chassis", cost: 45, teams: ["racingbulls"], tag: "SIGNATURE", equivalent: "sport",
        desc: "Racing Bulls signature chassis — Sport performance with slimline carbon arms", accel: 0.99, cornering: 1.08, braking: 1.02, visual: {ride: -0.004, arm: 1.008, push: 1, wishbone: 1.04, toe: 0.96, rocker: 0, heave: 1}, visualTier: 2 },
      { id: "sig_haas_susp", label: "Kannapolis Chassis", cost: 55, teams: ["haas"], tag: "SIGNATURE", equivalent: "carbon_pushrods",
        desc: "Haas signature chassis — Carbon Pushrods performance with pushrod actuation", accel: 1.01, cornering: 1.09, braking: 1.04, visual: { ride: -0.007, arm: 0.972, push: 1, wishbone: 0.92, toe: 1.08, rocker: 1 }, visualTier: 2 },
      { id: "sig_williams_susp", label: "Grove Chassis", cost: 75, teams: ["williams"], tag: "SIGNATURE", equivalent: "low_ride",
        desc: "Williams signature chassis — Low Ride Height performance with slimline carbon arms", speed: 1.02, accel: 0.99, cornering: 1.12, visual: { ride: -0.037, arm: 0.924, push: 0, wishbone: 1.12, toe: 0.88, rocker: 0 , heave: 1}, visualTier: 2 },
      { id: "sig_astonmartin_susp", label: "Silverstone Chassis", cost: 145, teams: ["astonmartin"], tag: "SIGNATURE", equivalent: "heave_spring",
        desc: "Aston Martin signature chassis — Heave Spring performance with a crossed pullrod actuator", speed: 1.03, cornering: 1.21, visual: { ride: -0.042, arm: 1.272, push: 1, pull: 1, wishbone: 0.94, toe: 1.06, rocker: 1 , heave: 1}, visualTier: 2 },
      { id: "sig_cadillac_susp", label: "Detroit Chassis", cost: 160, teams: ["cadillac"], tag: "SIGNATURE", equivalent: "inboard_dampers",
        desc: "Cadillac signature chassis — Inboard Dampers performance with a crossed pullrod actuator", accel: 1.02, cornering: 1.18, braking: 1.07, visual: { ride: -0.01, arm: 1.122, push: 1, pull: 1, wishbone: 0.98, toe: 1.02, rocker: 2 }, visualTier: 2 },
    ],
  },
  {
    id: "brakes", label: "BRAKES",
    // Each rung owns a HARDWARE SIGNATURE (caliper clock position, cover
    // solid / one-in-three / one-in-two, disc diameter and face) rather than
    // just a duct size, which renders all twelve tier-2 brakes with one
    // wheel face. 0.5 rad of caliperPos is ~130 mm at r*0.78, the loudest
    // single knob here. Costs and stats untouched.
    options: [
      { id: "standard",    label: "Standard",         cost:   0, desc: "Factory steel brake discs",                                                 visual: { cal: null, duct: 0.55, caliperPos: 0, coverOpen: 0, rotor: 1, rotorScale: 1 }, visualTier: 1 },
      // Cross-drilled: the drill pattern IS the option, so it opens the cover
      // one-in-three to show it. `discFace > 0` also flips the disc to the
      // carbon colour in car3d — correct enough for a steel disc carrying pad
      // transfer, and not a knob this file can separate.
      { id: "drilled",     label: "Drilled Steel",    cost:  25, desc: "Cross-drilled steel discs — improved heat management",                      braking: 1.05, visual: {"cal": null, "duct": 0.72, caliperPos: 0, coverOpen: 1, rotor: 1, rotorScale: 1.06, discFace: 1}, visualTier: 1 },
      { id: "sport",       label: "Sport",            cost:  40, desc: "Improved pads and discs",                                                   speed: 0.99, braking: 1.08, visual: {"cal": [0.95, 0.45, 0.05], "duct": 0.95, caliperPos: 0.9, coverOpen: 1, rotor: 1, rotorScale: 1.00, scoop: 0, caliper: 1}, visualTier: 2 },
      // Light alloy: the smallest disc on the ladder behind a solid cover, and
      // the caliper swung round to ~155° for the mass distribution the desc
      // sells. rotorScale 0.92 is a 25 mm radius cut — past the 20 mm floor on
      // its own, and the open covers around it make the diameter readable.
      { id: "titanium",    label: "Titanium Caliper", cost:  60, desc: "Lighter alloy calipers — better weight distribution and exit speed",        speed: 1.01, accel: 1.04, braking: 1.06, visual: {"cal": [0.7, 0.72, 0.78], "duct": 0.85, caliperPos: 2.7, coverOpen: 0, rotor: 1, rotorScale: 0.92, scoop: 0, caliper: 1}, visualTier: 1 },
      // Endurance: everything aimed at heat. Widest cover gaps (one in two),
      // the biggest disc short of the clamp, and a scooped duct fairing.
      { id: "endurance",   label: "Endurance",        cost:  60, desc: "Consistent fade-free braking — aids corner exit",                           speed: 0.98, accel: 1.02, braking: 1.10, visual: {"cal": [0.95, 0.8, 0.1], "duct": 1.05, caliper: 1, caliperPos: 0, coverOpen: 2, rotor: 2, rotorScale: 1.22, scoop: 1}, visualTier: 2 },
      { id: "dual_caliper",label: "Dual Caliper",     cost:  80, desc: "Twin-piston caliper setup — stronger bite with improved exit traction",     speed: 0.98, accel: 1.02, braking: 1.14, visual: {"cal": [0.95, 0.72, 0.08], "duct": 1.15, "rim": [0.3, 0.3, 0.34], caliper: 2, caliperPos: 1.5, coverOpen: 1, rotor: 1, rotorScale: 1.10, scoop: 0}, visualTier: 2 },
      { id: "carbon",      label: "Carbon",           cost:  85, desc: "F1-spec carbon composite brakes",                                           braking: 1.16, visual: {"cal": [0.85, 0.12, 0.1], "duct": 1.25, discFace: 1, caliper: 1, caliperPos: 5.7, coverOpen: 1, rotor: 2, rotorScale: 1.18, scoop: 0}, visualTier: 2 },
      { id: "ventilated",  label: "Ventilated Carbon",cost: 95, desc: "Internally vented discs — consistent fade-free stopping",                   speed: 0.97, braking: 1.18, visual: {"cal": [0.9, 0.15, 0.12], "duct": 1.35, discFace: 1, caliper: 1, caliperPos: 2.1, coverOpen: 2, rotor: 2, rotorScale: 1.14, scoop: 1}, visualTier: 2 },
      { id: "carbon_mag",  label: "Carbon-Mag",       cost: 120, desc: "Carbon-magnesium alloy — lighter, better mass dist",                        speed: 1.01, accel: 1.03, braking: 1.20, visual: {"cal": [0.85, 0.66, 0.16], "duct": 1.45, "rim": [0.48, 0.4, 0.16], caliper: 1, caliperPos: 4.8, coverOpen: 1, rotor: 2, rotorScale: 1.25, scoop: 1}, visualTier: 2 },
      // Brake-by-wire: the MGU-K does most of the retardation, so the FRICTION
      // disc is the smallest on the tier-2 shelf (0.88) behind a closed cover —
      // the one brake on the ladder that looks like less hardware, not more.
      { id: "regen_brakes",label: "Regen Brakes",     cost: 130, desc: "Brake-by-wire hybrid system — converts braking energy into acceleration",   speed: 1.02, accel: 1.06, braking: 1.12, visual: {"cal": [0.15, 0.78, 0.38], "duct": 1.25, caliper: 1, caliperPos: 5.2, coverOpen: 0, rotor: 2, rotorScale: 0.88, scoop: 0, discFace: 0}, visualTier: 2 },
      { id: "ceramic",     label: "Carbon Ceramic",   cost: 135, desc: "Maximum stopping power — zero fade",                                        speed: 0.98, braking: 1.24, visual: {"cal": [0.97, 0.1, 0.08], "duct": 1.6, "rim": [0.55, 0.56, 0.6], discFace: 2, caliper: 1, caliperPos: 4.4, coverOpen: 1, rotor: 2, rotorScale: 1.20, scoop: 1}, visualTier: 2 },
      { id: "brembo_evo",  label: "Brembo Evo",       cost: 165, desc: "Next-gen racing brake package — ultimate stopping with mass benefit",        speed: 1.01, accel: 1.04, braking: 1.26, visual: {"cal": [0.98, 0.62, 0.05], "duct": 1.75, "rim": [0.42, 0.34, 0.12], caliper: 2, caliperPos: 0.35, coverOpen: 1, rotor: 2, rotorScale: 1.25, scoop: 1, discFace: 0}, visualTier: 2 },
      // `caliper: 2` IS the six-piston radial body in car3d — the option was
      // named for hardware it never asked for and drew the stock three-box
      // peek while the cheaper brembo_evo got the radial. Fixed here.
      { id: "six_piston",   label: "Six Piston",       cost: 180, desc: "Large monobloc calipers — peak initial bite with stable trail braking",       speed: 0.97, cornering: 1.02, braking: 1.27, visual: { cal: [0.10, 0.65, 0.95], duct: 1.55, rim: [0.24, 0.28, 0.34], discFace: 2, caliper: 2, caliperPos: 3.6, coverOpen: 2, rotor: 2, rotorScale: 1.16, scoop: 1 }, visualTier: 2 },
      { id: "mono_steel",   label: "Monobloc Steel",   cost:  60, desc: "One-piece steel calipers — predictable bite with no exotic materials",        speed: 0.99, braking: 1.12, visual: { cal: [0.62, 0.64, 0.70], duct: 0.95, scoop: 0, rotor: 1, rotorScale: 1.02 , caliper: 1, caliperPos: 4.0, coverOpen: 0}, visualTier: 1 },
      { id: "scoop_wrap",   label: "Wrapped Ducts",    cost: 110, desc: "Boomerang duct fairings wrapping the wheel face — cooling that also turns air", speed: 0.96, cornering: 1.02, braking: 1.19, visual: { cal: [0.20, 0.55, 0.85], duct: 1.30, scoop: 2, rim: [0.26, 0.30, 0.36], discFace: 1 , caliper: 2, caliperPos: 3.2, coverOpen: 0, rotor: 1, rotorScale: 1.00}, visualTier: 2 },
      { id: "cryo_pack",    label: "Cryo Pack",        cost: 150, desc: "Cryogenically treated discs — deep, repeatable stopping power under load",     accel: 1.02, braking: 1.25, visual: { cal: [0.72, 0.86, 0.95], duct: 1.62, scoop: 2, rim: [0.50, 0.54, 0.60], discFace: 2 , caliper: 1, caliperPos: 6.0, coverOpen: 2, rotor: 2, rotorScale: 1.10}, visualTier: 2 },
      { id: "sig_ferrari_brembo", label: "Maranello Brembo", cost: 165, teams: ["ferrari"], tag: "SIGNATURE", equivalent: "brembo_evo",
        desc: "Ferrari signature brake package — Brembo Evo performance with red monobloc hardware", speed: 1.01, accel: 1.04, braking: 1.26, visual: {cal: [0.95, 0.05, 0.04], duct: 1.7, rim: [0.52, 0.45, 0.2], discFace: 2, caliper: 1, caliperPos: 5.2, rotorScale: 1.07}, visualTier: 2 },
      { id: "sig_haas_carbonmag", label: "Kannapolis C-Mag", cost: 120, teams: ["haas"], tag: "SIGNATURE", equivalent: "carbon_mag",
        desc: "Haas signature lightweight brake — Carbon-Mag performance with pale alloy hardware", speed: 1.01, accel: 1.03, braking: 1.20, visual: {cal: [0.88, 0.88, 0.9], duct: 1.42, rim: [0.42, 0.18, 0.14], discFace: 0, caliper: 2, scoop: 2, rotorScale: 1.06, caliperPos: 0.9}, visualTier: 2 },
      { id: "sig_mercedes_discs", label: "Brackley Discs", cost: 135, teams: ["mercedes"], tag: "SIGNATURE", equivalent: "ceramic",
        desc: "Mercedes signature brake package — Carbon Ceramic performance with team-teal hardware", speed: 0.98, braking: 1.24, visual: {cal: [0, 0.75, 0.7], duct: 1.55, rim: [0.6, 0.62, 0.66], discFace: 1, caliper: 1, caliperPos: 1.6, rotorScale: 1.05}, visualTier: 2 },
      { id: "sig_aston_carbon", label: "Lagonda Carbon", cost: 95, teams: ["astonmartin"], tag: "SIGNATURE", equivalent: "ventilated",
        desc: "Aston Martin signature vented brake — Ventilated Carbon performance with racing-green monoblocs", speed: 0.97, braking: 1.18, visual: {cal: [0, 0.55, 0.38], duct: 1.4, rim: [0.5, 0.44, 0.2], discFace: 2, caliper: 2, scoop: 2, caliperPos: 4, rotorScale: 0.94}, visualTier: 2 },
      { id: "sig_mclaren_brakes", label: "Woking Brake Pack", cost: 180, teams: ["mclaren"], tag: "SIGNATURE", equivalent: "six_piston",
        desc: "McLaren signature brake pack — Six Piston performance with a duct winglet", speed: 0.97, cornering: 1.02, braking: 1.27, visual: { cal: [1, 0.5, 0], duct: 1.643, rim: [0.24, 0.28, 0.34], scoop: 1, discFace: 1 , caliper: 2}, visualTier: 2 },
      { id: "sig_redbull_brakes", label: "Milton Keynes Brake Pack", cost: 120, teams: ["redbull"], tag: "SIGNATURE", equivalent: "carbon_mag",
        desc: "Red Bull signature brake pack — Carbon-Mag performance with wrapped boomerang ducts", speed: 1.01, accel: 1.03, braking: 1.20, visual: { cal: [0.95, 0.78, 0], duct: 1.624, rim: [0.48, 0.4, 0.16], scoop: 2, discFace: 2 , caliper: 1}, visualTier: 2 },
      { id: "sig_alpine_brakes", label: "Enstone Brake Pack", cost: 95, teams: ["alpine"], tag: "SIGNATURE", equivalent: "ventilated",
        desc: "Alpine signature brake pack — Ventilated Carbon performance with a duct winglet", speed: 0.97, braking: 1.18, visual: {cal: [1, 0.53, 0.74], duct: 1.296, scoop: 1, discFace: 2, caliper: 2, rotorScale: 1.08, caliperPos: 2.2}, visualTier: 2 },
      { id: "sig_racingbulls_brakes", label: "Faenza Brake Pack", cost: 40, teams: ["racingbulls"], tag: "SIGNATURE", equivalent: "sport",
        desc: "Racing Bulls signature brake pack — Sport performance with bare duct inlets", speed: 0.99, braking: 1.08, visual: { cal: [0.2, 0.3, 0.95], duct: 0.874, scoop: 0, discFace: 0 , caliper: 1}, visualTier: 2 },
      { id: "sig_williams_brakes", label: "Grove Brake Pack", cost: 60, teams: ["williams"], tag: "SIGNATURE", equivalent: "titanium",
        desc: "Williams signature brake pack — Titanium Caliper performance with a duct winglet", speed: 1.01, accel: 1.04, braking: 1.06, visual: { cal: [0.2, 0.55, 0.95], duct: 0.765, scoop: 1, discFace: 1 , caliper: 1}, visualTier: 1 },
      { id: "sig_audi_brakes", label: "Neuburg Brake Pack", cost: 130, teams: ["audi"], tag: "SIGNATURE", equivalent: "regen_brakes",
        desc: "Audi signature brake pack — Regen Brakes performance with wrapped boomerang ducts", speed: 1.02, accel: 1.06, braking: 1.12, visual: { cal: [0.98, 0.28, 0.05], duct: 1.425, scoop: 2, discFace: 2 }, visualTier: 2 },
      { id: "sig_cadillac_brakes", label: "Detroit Brake Pack", cost: 60, teams: ["cadillac"], tag: "SIGNATURE", equivalent: "endurance",
        desc: "Cadillac signature brake pack — Endurance performance with wrapped boomerang ducts", speed: 0.98, accel: 1.02, braking: 1.10, visual: { cal: [0.85, 0.7, 0.32], duct: 1.218, scoop: 2, discFace: 0 }, visualTier: 2 },
    ],
  },
  {
    id: "tyres", label: "TYRES",
    options: [
      // Open rim is the default (#1190). coverVanes alone never builds a cover —
      // opt in with cover:1, or put identity on spokes / dish / gunNut / band.
      { id: "intermediate", label: "Intermediate",  cost:   0, desc: "Wet-weather compound — green band, three grooves, 4-spoke open rim",                         speed: 0.92, accel: 0.93, cornering: 0.94, braking: 0.98, wetTread: 1, life: 1.01, visual: {band: [0.1, 0.72, 0.24], grooves: 3, grooveDepth: 0.055, bandWidth: 0.08, spokes: 4}, visualTier: 0 },
      { id: "hard",         label: "Hard",          cost:   0, desc: "Durable compound — white band, thin wall, 5-spoke open rim",                               speed: 1.02, accel: 0.97, cornering: 0.92, braking: 1.02, life: 1.06, visual: {band: [0.9, 0.9, 0.93], grooves: 0, bandWidth: 0.05, spokes: 5}, visualTier: 0 },
      { id: "medium",       label: "Medium",        cost:   0, desc: "Balanced compound — yellow band on the stock open rim",                                        life: 0.88, visual: {band: [0.96, 0.8, 0.1], grooves: 0, bandWidth: 0.075, spokes: 3}, visualTier: 1 },
      { id: "slick_track",  label: "Slick Track",   cost:  40, desc: "Pure dry-weather slick — silver band, recessed open dish, hex gun nut",                       speed: 1.01, accel: 1.01, cornering: 1.04, braking: 1.04, life: 0.88, visual: {band: [0.8, 0.82, 0.88], grooves: 0, bandWidth: 0.045, spokes: 6, dish: 1, gunNut: 1}, visualTier: 1 },
      { id: "compound_c4",  label: "Compound C4",   cost:  55, desc: "Pirelli's track-ready soft — orange band, 4-spoke open rim with a shallow dish",         speed: 0.98, accel: 1.02, cornering: 1.08, braking: 1.06, life: 0.76, visual: {band: [0.95, 0.42, 0.1], grooves: 0, bandWidth: 0.085, spokes: 4, dish: 1}, visualTier: 2 },
      { id: "soft",         label: "Soft",          cost:  80, desc: "+12% cornering, +4% accel — red band, rounded shoulder, 5-spoke open rim",                            speed: 0.97, accel: 1.04, cornering: 1.12, braking: 1.06, life: 0.67, visual: {band: [0.92, 0.12, 0.1], grooves: 0, bandWidth: 0.1, spokes: 5, shoulder: 1}, visualTier: 2 },
      // The softest dry compound wears the widest band, the squared shoulder
      // and a magenta wall nobody else has, not a 20 cr reskin of `soft`
      // (band colours 5 % apart fall under the sweep's 0.06 floor).
      { id: "compound_c5",  label: "Compound C5",   cost: 100, desc: "High-spec soft — magenta band, squared shoulder, 4-spoke open rim",               speed: 0.96, accel: 1.05, cornering: 1.15, braking: 1.08, life: 0.52, visual: {band: [1.00, 0.34, 0.62], grooves: 0, bandWidth: 0.132, spokes: 4, shoulder: 2, gunNut: 1}, visualTier: 2 },
      { id: "supersoft",    label: "Super Soft",    cost: 125, desc: "High grip compound — pink band, squared shoulder, 6-spoke open rim",                                   speed: 0.94, accel: 1.06, cornering: 1.20, braking: 1.10, life: 0.50, visual: {band: [0.88, 0.1, 0.3], grooves: 0, bandWidth: 0.12, spokes: 6, shoulder: 2, gunNut: 1}, visualTier: 2 },
      { id: "p_zero_red",   label: "P Zero Red",    cost: 145, desc: "Custom Pirelli high-performance — red band, raised sidewall ring, 7-spoke open rim",     speed: 0.92, accel: 1.07, cornering: 1.24, braking: 1.13, life: 0.56, visual: {sidewall: 1, band: [0.97, 0.07, 0.07], grooves: 0, bandWidth: 0.13, spokes: 7, dish: 1}, visualTier: 2 },
      { id: "qualigum",     label: "Quali Spec",    cost: 165, desc: "One-lap ultra-soft — purple band, twin sidewall rings, deep-dish 8-spoke open rim",                                 speed: 0.91, accel: 1.09, cornering: 1.28, braking: 1.11, life: 0.34, visual: {sidewall: 2, band: [0.62, 0.12, 0.78], grooves: 0, bandWidth: 0.14, spokes: 8, dish: 2, gunNut: 1}, visualTier: 2 },
      { id: "hypersoft",    label: "Hyper Soft",    cost: 205, desc: "Prototype extreme — pink-magenta band, squared shoulder, deep-dish open rim",          speed: 0.88, accel: 1.12, cornering: 1.36, braking: 1.16, life: 0.30, visual: {sidewall: 2, band: [0.98, 0.38, 0.62], grooves: 0, bandWidth: 0.15, spokes: 8, dish: 2, shoulder: 2, gunNut: 1}, visualTier: 2 },
      { id: "sprint_soft",  label: "Sprint Soft",   cost: 135, desc: "Short-race compound — blue band, 7-spoke open rim with a shallow dish",                 speed: 0.93, accel: 1.08, cornering: 1.22, braking: 1.09, life: 0.44, visual: {band: [0.15, 0.55, 0.95], grooves: 0, bandWidth: 0.105, spokes: 7, dish: 1}, visualTier: 2 },
      { id: "wet_full",     label: "Full Wet",      cost:   0, desc: "Deep-tread monsoon tyre — blue band, four grooves, squared shoulder, 4-spoke open rim",         speed: 0.88, accel: 0.90, cornering: 0.90, braking: 0.94, wetTread: 2, life: 1.11, visual: {band: [0.1, 0.4, 0.92], grooves: 4, grooveDepth: 0.075, bandWidth: 0.09, spokes: 4, shoulder: 2}, visualTier: 0 },
      { id: "compound_c3",  label: "Compound C3",   cost:  50, desc: "Pirelli's workhorse medium-hard — yellow-grey band, squared shoulder, 6-spoke open rim", speed: 1.01, accel: 1.01, cornering: 1.05, braking: 1.05, life: 0.92, visual: {band: [0.92, 0.92, 0.6], grooves: 0, bandWidth: 0.065, spokes: 6, shoulder: 2}, visualTier: 1 },
      // Genuine covered face — the one catalogue tyre that still opts the 2022–25
      // three-ring cover back in (not a factory preset; open rim stays the default).
      { id: "endurance_tyre", label: "Endurance Spec", cost: 70, desc: "Reinforced casing — grey band, raised sidewall, 12-vane wheel cover", speed: 1.02, cornering: 1.06, braking: 1.10, life: 1.00, visual: {sidewall: 1, band: [0.55, 0.58, 0.64], grooves: 0, bandWidth: 0.055, cover: 1, coverVanes: 12, shoulder: 1}, visualTier: 1 },
      { id: "branded_wall", label: "Branded Wall", cost: 15, desc: "Double raised lettering rings on the sidewall — white band, 5-spoke open rim", cornering: 1.02, braking: 1.02, life: 0.84, visual: {sidewall: 2, band: [0.94, 0.94, 0.96], grooves: 0, bandWidth: 0.06, spokes: 5, shoulder: 0}, visualTier: 1 },
      { id: "sig_cadillac_sprint", label: "Cadillac Sprint", cost: 135, teams: ["cadillac"], tag: "SIGNATURE", equivalent: "sprint_soft",
        desc: "Cadillac signature sprint compound — Sprint Soft performance with a gold double-width band and squared shoulder", speed: 0.93, accel: 1.08, cornering: 1.22, braking: 1.09, life: 0.44, visual: {sidewall: 2, band: [0.92, 0.72, 0.18], grooves: 0, bandWidth: 0.125, spokes: 4, shoulder: 2, gunNut: 1, nut: [0.92, 0.72, 0.18]}, visualTier: 2 },
      { id: "sig_rb_street", label: "Faenza Street", cost: 125, teams: ["racingbulls"], tag: "SIGNATURE", equivalent: "supersoft",
        desc: "Racing Bulls signature street compound — Super Soft performance with a twin-blue sidewall band and 5-spoke open rim", speed: 0.94, accel: 1.06, cornering: 1.20, braking: 1.10, life: 0.50, visual: {sidewall: 1, band: [0.2, 0.3, 0.95], grooves: 0, bandWidth: 0.135, spokes: 5, shoulder: 1, nut: [0.2, 0.3, 0.95]}, visualTier: 2 },
      { id: "sig_mercedes_tyre", label: "Brackley Compound", cost: 0, teams: ["mercedes"], tag: "SIGNATURE", equivalent: "medium",
        desc: "Mercedes signature compound — Medium performance with a teal sidewall band, squared shoulder and hex gun nut", speed: 1.00, accel: 1.00, cornering: 1.00, life: 0.88, visual: {sidewall: 2, band: [0, 0.72, 0.68], grooves: 0, bandWidth: 0.088, spokes: 5, dish: 1, shoulder: 2, gunNut: 1, nut: [0, 0.72, 0.68]}, visualTier: 1 },
      { id: "sig_ferrari_tyre", label: "Maranello Compound", cost: 80, teams: ["ferrari"], tag: "SIGNATURE", equivalent: "soft",
        desc: "Ferrari signature compound — Soft performance with a gold sidewall band, raised lettering and 6-spoke open rim", speed: 0.97, accel: 1.04, cornering: 1.12, braking: 1.06, life: 0.67, visual: {sidewall: 1, band: [0.98, 0.78, 0.06], grooves: 0, bandWidth: 0.125, spokes: 6, shoulder: 1, nut: [0.98, 0.78, 0.06]}, visualTier: 2 },
      { id: "sig_mclaren_tyre", label: "Woking Compound", cost: 135, teams: ["mclaren"], tag: "SIGNATURE", equivalent: "sprint_soft",
        desc: "McLaren signature compound — Sprint Soft performance with a papaya band, raised lettering and deep-dish open rim", speed: 0.93, accel: 1.08, cornering: 1.22, braking: 1.09, life: 0.44, visual: {sidewall: 2, band: [1, 0.47, 0], grooves: 0, bandWidth: 0.118, spokes: 8, dish: 2, shoulder: 1, gunNut: 1, nut: [1, 0.47, 0]}, visualTier: 2 },
      { id: "sig_redbull_tyre", label: "Milton Keynes Compound", cost: 80, teams: ["redbull"], tag: "SIGNATURE", equivalent: "soft",
        desc: "Red Bull signature compound — Soft performance with a navy sidewall band, squared shoulder and 7-spoke open rim", speed: 0.97, accel: 1.04, cornering: 1.12, braking: 1.06, life: 0.67, visual: {sidewall: 2, band: [0.1, 0.2, 0.72], grooves: 0, bandWidth: 0.115, spokes: 7, dish: 1, shoulder: 2, nut: [0.95, 0.78, 0]}, visualTier: 2 },
      { id: "sig_alpine_tyre", label: "Enstone Compound", cost: 55, teams: ["alpine"], tag: "SIGNATURE", equivalent: "compound_c4",
        desc: "Alpine signature compound — Compound C4 performance with a pink sidewall band, single groove and 5-spoke open rim", speed: 0.98, accel: 1.02, cornering: 1.08, braking: 1.06, life: 0.76, visual: {sidewall: 1, band: [1, 0.53, 0.74], grooves: 1, bandWidth: 0.128, spokes: 5, dish: 1, shoulder: 1, grooveDepth: 0.05, nut: [1, 0.53, 0.74]}, visualTier: 2 },
      { id: "sig_haas_tyre", label: "Kannapolis Compound", cost: 0, teams: ["haas"], tag: "SIGNATURE", equivalent: "hard",
        desc: "Haas signature compound — Hard performance with a red sidewall band, raised lettering and 8-spoke open rim", speed: 1.02, accel: 0.97, cornering: 0.92, braking: 1.02, life: 1.06, visual: {sidewall: 2, band: [0.86, 0.16, 0.11], grooves: 0, bandWidth: 0.095, spokes: 8, shoulder: 1, nut: [0.88, 0.88, 0.9]}, visualTier: 0 },
      { id: "sig_williams_tyre", label: "Grove Compound", cost: 0, teams: ["williams"], tag: "SIGNATURE", equivalent: "hard",
        desc: "Williams signature compound — Hard performance with a blue sidewall band, squared shoulder and 6-spoke open rim", speed: 1.02, accel: 0.97, cornering: 0.92, braking: 1.02, life: 1.06, visual: {sidewall: 2, band: [0.15, 0.42, 0.95], grooves: 0, bandWidth: 0.082, spokes: 6, dish: 1, shoulder: 2, nut: [0.2, 0.55, 0.95]}, visualTier: 0 },
      { id: "sig_audi_tyre", label: "Neuburg Compound", cost: 55, teams: ["audi"], tag: "SIGNATURE", equivalent: "compound_c4",
        // Band = Teams.audi.color2 (Audi red-orange #FA470D). Was [0.75,0.1,0.3]
        // (supersoft magenta) — pink tyre walls on the titanium/black/red car.
        desc: "Audi signature compound — Compound C4 performance with an Audi-red sidewall band and 7-spoke open rim", speed: 0.98, accel: 1.02, cornering: 1.08, braking: 1.06, life: 0.76, visual: {sidewall: 1, band: [0.98, 0.28, 0.05], grooves: 0, bandWidth: 0.135, spokes: 7, dish: 2, shoulder: 1, gunNut: 1, nut: [0.98, 0.28, 0.05]}, visualTier: 2 },
      { id: "sig_astonmartin_tyre", label: "Silverstone Compound", cost: 80, teams: ["astonmartin"], tag: "SIGNATURE", equivalent: "soft",
        desc: "Aston Martin signature compound — Soft performance with a lime sidewall band, squared shoulder and 4-spoke open rim", speed: 0.97, accel: 1.04, cornering: 1.12, braking: 1.06, life: 0.67, visual: {sidewall: 2, band: [0.72, 0.88, 0.11], grooves: 0, bandWidth: 0.072, spokes: 4, dish: 1, shoulder: 2, nut: [0.72, 0.88, 0.11]}, visualTier: 2 },
    ],
  },
  {
    id: "ers", label: "ERS",
    // Every universal option owns a distinct (pack, cells, blister, conduit,
    // coolerIntake) tuple and `cells` (1-8 glowing boxes per pod flank) follows
    // the story — one inherited six-cell default makes `overtake_focus` /
    // `race_mode` byte-identical. Costs and stats untouched.
    options: [
      { id: "standard",       label: "Standard",      cost:   0, desc: "Balanced energy recovery and deployment",                                    visual: { led: [0.15, 0.55, 1.6], pack: 1.0, cells: 3 }, visualTier: 1 },
      { id: "regen_plus",     label: "Regen+",        cost:  90, desc: "Enhanced braking recovery — harvests extra energy under braking",            accel: 1.05, braking: 1.05, visual: {led: [0.12, 1.5, 0.55], pack: 1.05, blister: 1, cells: 4}, visualTier: 1 },
      { id: "harvest",        label: "Harvest",       cost:  30, desc: "Aggressive recovery: +2% top speed, −5% accel",                             speed: 1.02, accel: 0.95, braking: 1.04, visual: {led: [0.18, 1.35, 0.95], pack: 0.95, conduit: 1, coolerIntake: 1, cells: 2, blister: 0}, visualTier: 0 },
      { id: "split_deploy",   label: "Split Deploy",  cost:  90, desc: "Per-axle deployment control — improved cornering traction and accel",        accel: 1.06, cornering: 1.05, visual: {led: [0.85, 0.55, 1.7], pack: 1.1, blister: 2, cells: 5}, visualTier: 1 },
      { id: "mgu_k_max",      label: "MGU-K Max",     cost:  80, desc: "Dedicated kinetic unit — strong deployment burst on straights",              speed: 0.98, accel: 1.09, visual: {led: [1.7, 0.95, 0.15], pack: 1.15, coolerIntake: 1, cells: 5}, visualTier: 2 },
      { id: "deploy",         label: "Deploy",        cost: 100, desc: "Full deployment: +10% accel, −3% top speed",                                speed: 0.97, accel: 1.11, visual: {"led": [1.9, 0.4, 0.15], "pack": 1.2, cells: 6, blister: 0, conduit: 1}, visualTier: 2 },
      { id: "thermal_max",    label: "Thermal Max",   cost:  70, desc: "Heat energy recovery focus — speed gains with consistent braking",           speed: 1.04, braking: 1.03, visual: { coolerIntake: 2,"led": [1.95, 0.5, 0.08], "pack": 1.05, cells: 3, blister: 0}, visualTier: 1 },
      { id: "torque_fill",    label: "Torque Fill",   cost: 135, desc: "Hybrid torque-vectoring — cornering traction and exit speed",                accel: 1.08, cornering: 1.06, visual: {led: [0.8, 0.3, 1.85], pack: 1.15, conduit: 1, blister: 1, cells: 3, coolerIntake: 0}, visualTier: 2 },
      { id: "overtake_focus", label: "OT Focus",      cost: 115, desc: "Traction-biased deploy: +12% accel, +4% cornering",                         speed: 0.96, accel: 1.12, cornering: 1.04, visual: {"led": [2.05, 0.15, 0.55], "pack": 1.24, blister: 2, cells: 8, conduit: 0, coolerIntake: 0}, visualTier: 2 },
      { id: "race_mode",      label: "Race Mode",     cost: 115, desc: "High-output 2026 mode: +7% accel, +3% top speed",                           speed: 1.03, accel: 1.07, cornering: 1.02, braking: 1.02, visual: {"led": [0.25, 0.95, 2.05], "pack": 1.12, blister: 1, cells: 4, conduit: 2, coolerIntake: 1}, visualTier: 2 },
      { id: "full_attack",    label: "Full Attack",   cost: 195, desc: "Maximum ERS output — qualifying/sprint spec",                               speed: 1.07, accel: 1.16, visual: { coolerIntake: 1,"led": [2.25, 0.22, 0.16], "pack": 1.3, blister: 1, cells: 5, conduit: 1}, visualTier: 2 },
      { id: "overcharge",     label: "Overcharge",    cost: 230, desc: "Experimental limit-push mode — maximum all-channel ERS output",              speed: 1.10, accel: 1.18, visual: { coolerIntake: 2,"led": [2.4, 0.75, 0.06], "pack": 1.35, blister: 2, cells: 8, conduit: 2}, visualTier: 2 },
      { id: "supercapacitor", label: "Supercapacitor", cost: 180, desc: "High-discharge buffer — immediate deployment with improved recovery",        speed: 1.04, accel: 1.13, braking: 1.04, visual: { coolerIntake: 2, led: [0.30, 2.20, 2.20], pack: 1.10 , blister: 2, cells: 2, conduit: 0}, visualTier: 2 },
      // External-conduit packages — visible high-voltage plumbing on the cover.
      { id: "harvest_max",    label: "Harvest Max",   cost:  95, desc: "Maximum recovery window — tops the pack up everywhere without hurting pace",   speed: 1.01, accel: 1.02, braking: 1.08, visual: { coolerIntake: 2, led: [0.20, 1.60, 0.85], pack: 1.08, cells: 6, conduit: 2 , blister: 0}, visualTier: 1 },
      { id: "conduit_twin",   label: "Twin Conduit",  cost: 130, desc: "Doubled deployment loom — steady high-current delivery out of every corner",   speed: 1.02, accel: 1.11, cornering: 1.03, visual: { led: [0.35, 0.85, 2.05], pack: 1.18, cells: 6, conduit: 2 , blister: 1}, visualTier: 2 },
      { id: "burst_map",      label: "Burst Map",     cost: 155, desc: "Short, violent deployment bursts — overtaking punch with cornering traction",  speed: 0.98, accel: 1.13, cornering: 1.05, visual: { led: [2.15, 0.45, 0.12], pack: 1.26, cells: 7, conduit: 2 , blister: 2, coolerIntake: 1}, visualTier: 2 },
      { id: "sig_audi_quattro", label: "Quattro Hybrid", cost: 180, teams: ["audi"], tag: "SIGNATURE", equivalent: "supercapacitor",
        desc: "Audi signature deployment map — Supercapacitor performance with a red energy conduit", speed: 1.04, accel: 1.13, braking: 1.04, visual: { coolerIntake: 2, led: [2.35, 0.18, 0.08], pack: 1.12 , blister: 1}, visualTier: 2 },
      { id: "sig_alpine_boost", label: "Enstone Boost", cost: 115, teams: ["alpine"], tag: "SIGNATURE", equivalent: "race_mode",
        desc: "Alpine signature deployment map — Race Mode performance with a rose-glow energy cell", speed: 1.03, accel: 1.07, cornering: 1.02, braking: 1.02, visual: { coolerIntake: 1, led: [1.90, 0.55, 1.20], pack: 1.18 , blister: 2}, visualTier: 2 },
      { id: "sig_mercedes_ers", label: "Brackley Deploy Map", cost: 115, teams: ["mercedes"], tag: "SIGNATURE", equivalent: "race_mode",
        desc: "Mercedes signature deploy map — Race Mode performance with an external conduit run", speed: 1.03, accel: 1.07, cornering: 1.02, braking: 1.02, visual: { coolerIntake: 1, led: [0.1, 1.85, 1.7], pack: 1.14, cells: 5, conduit: 1 , blister: 2}, visualTier: 2 },
      { id: "sig_ferrari_ers", label: "Maranello Deploy Map", cost: 135, teams: ["ferrari"], tag: "SIGNATURE", equivalent: "torque_fill",
        desc: "Ferrari signature deploy map — Torque Fill performance with a twin external conduit", accel: 1.08, cornering: 1.06, visual: { coolerIntake: 2, led: [2.1, 0.2, 0.12], pack: 1.196, cells: 7, conduit: 2 , blister: 1}, visualTier: 2 },
      { id: "sig_mclaren_ers", label: "Woking Deploy Map", cost: 180, teams: ["mclaren"], tag: "SIGNATURE", equivalent: "supercapacitor",
        desc: "McLaren signature deploy map — Supercapacitor performance with a twin external conduit", speed: 1.04, accel: 1.13, braking: 1.04, visual: { coolerIntake: 1, led: [2.2, 1.05, 0.05], pack: 1.078, cells: 6, conduit: 2 , blister: 1}, visualTier: 2 },
      { id: "sig_redbull_ers", label: "Milton Keynes Deploy Map", cost: 115, teams: ["redbull"], tag: "SIGNATURE", equivalent: "overtake_focus",
        desc: "Red Bull signature deploy map — OT Focus performance with an external conduit run", speed: 0.96, accel: 1.12, cornering: 1.04, visual: { coolerIntake: 2, led: [2.15, 1.7, 0.1], pack: 1.224, cells: 4, conduit: 1 , blister: 1}, visualTier: 2 },
      { id: "sig_racingbulls_ers", label: "Faenza Deploy Map", cost: 90, teams: ["racingbulls"], tag: "SIGNATURE", equivalent: "split_deploy",
        desc: "Racing Bulls signature deploy map — Split Deploy performance with an external conduit run", accel: 1.06, cornering: 1.05, visual: { coolerIntake: 0, led: [0.35, 0.6, 2.25], pack: 1.067, cells: 5, conduit: 1 , blister: 1}, visualTier: 1 },
      { id: "sig_haas_ers", label: "Kannapolis Deploy Map", cost: 30, teams: ["haas"], tag: "SIGNATURE", equivalent: "harvest",
        desc: "Haas signature deploy map — Harvest performance with an external conduit run", speed: 1.02, accel: 0.95, braking: 1.04, visual: { coolerIntake: 0, led: [1.8, 1.8, 1.95], pack: 0.997, cells: 3, conduit: 1 , blister: 2}, visualTier: 0 },
      { id: "sig_williams_ers", label: "Grove Deploy Map", cost: 70, teams: ["williams"], tag: "SIGNATURE", equivalent: "thermal_max",
        desc: "Williams signature deploy map — Thermal Max performance with an external conduit run", speed: 1.04, braking: 1.03, visual: { coolerIntake: 1, led: [0.25, 1.15, 2.2], pack: 0.976, cells: 4, conduit: 1 , blister: 2}, visualTier: 1 },
      { id: "sig_astonmartin_ers", label: "Silverstone Deploy Map", cost: 195, teams: ["astonmartin"], tag: "SIGNATURE", equivalent: "full_attack",
        desc: "Aston Martin signature deploy map — Full Attack performance with an external conduit run", speed: 1.07, accel: 1.16, visual: { coolerIntake: 2, led: [1.35, 2.15, 0.25], pack: 1.287, cells: 6, conduit: 1 }, visualTier: 2 },
      { id: "sig_cadillac_ers", label: "Detroit Deploy Map", cost: 100, teams: ["cadillac"], tag: "SIGNATURE", equivalent: "deploy",
        desc: "Cadillac signature deploy map — Deploy performance with a twin external conduit", speed: 0.97, accel: 1.11, visual: { coolerIntake: 1, led: [2.05, 1.55, 0.6], pack: 1.272, cells: 8, conduit: 2 }, visualTier: 2 },
    ],
  },
  {
    id: "gearbox", label: "GEARBOX",
    options: [
      { id: "standard",      label: "Standard",       cost:   0, desc: "Factory sequential 8-speed — baseline shift performance",                    visual: { strakes: 0, fin: 0, strakeH: 0.13, casing: 0, louvres: 0, heat: 0, caseWidth: 1 }, visualTier: 1 },
      { id: "close_ratio",   label: "Close Ratio",    cost:  50, desc: "Tighter gear spacing — stronger drive out of slow corners",                  speed: 0.98, accel: 1.06, braking: 1.03, visual: {"strakes": 2, "fin": 0, "strakeH": 0.13, "casing": 1, "louvres": 2, "heat": 0}, visualTier: 1 },
      { id: "long_ratio",    label: "Long Ratio",     cost:  40, desc: "Wider gear spacing — improved top speed on power circuits",                  speed: 1.04, accel: 0.97, braking: 0.98, visual: {"strakes": 2, "fin": 0, "strakeH": 0.16, "casing": 1, "louvres": 0, "heat": 1}, visualTier: 1 },
      { id: "short_stack",   label: "Short Stack",    cost:  70, desc: "Extra-short first gear — explosive launch and corner exit traction",         accel: 1.08, cornering: 1.03, braking: 1.05, speed: 0.95, visual: {"strakes": 3, "fin": 1, "strakeH": 0.15, "finSY": 0.11, "finSZ": 0.22, "casing": 2, "louvres": 3, "heat": 0}, visualTier: 2 },
      { id: "sequential_pro",label: "Sequential Pro", cost:  90, desc: "Faster shift times — reduced power interruption through the rev range",      speed: 1.02, accel: 1.07, braking: 1.01, visual: {"strakes": 4, "fin": 1, "strakeH": 0.17, "finSY": 0.17, "finSZ": 0.32, "casing": 2, "louvres": 4, "heat": 1}, visualTier: 2 },
      { id: "carbon_case",   label: "Carbon Case",    cost: 140, desc: "Lightweight carbon housing — mass reduction improves accel and handling",     speed: 1.02, accel: 1.08, cornering: 1.03, braking: 1.03, visual: {"strakes": 4, "fin": 1, "strakeH": 0.19, "finSY": 0.15, "finSZ": 0.3, "casing": 3, "louvres": 0, "heat": 1}, visualTier: 2 },
      { id: "f1_spec",       label: "F1 Spec",        cost: 180, desc: "Race-validated paddle-shift unit — peak response and powerflow efficiency",   speed: 1.04, accel: 1.10, cornering: 1.03, braking: 1.03, visual: {"strakes": 5, "fin": 1, "strakeH": 0.22, "finSY": 0.22, "finSZ": 0.4, "casing": 3, "louvres": 5, "heat": 1}, visualTier: 2 },
      { id: "seamless_shift",label: "Seamless Shift", cost: 210, desc: "Continuous torque transfer — maximum shift response with minimal interruption", speed: 1.05, accel: 1.12, cornering: 1.02, braking: 1.04, visual: { strakes: 5, fin: 1, strakeH: 0.20, finSY: 0.18, finSZ: 0.36, casing: 2, louvres: 6, heat: 1 }, visualTier: 2 },
      { id: "wide_stack",    label: "Wide Stack",     cost:  60, desc: "Widely spaced upper gears — carries speed down the longest straights",         speed: 1.05, accel: 0.96, braking: 0.97, visual: { strakes: 2, fin: 0, strakeH: 0.18, casing: 1, louvres: 1, heat: 1, caseWidth: 1.14 }, visualTier: 1 },
      { id: "quickshift",    label: "Quickshift",     cost: 110, desc: "Reduced shift latency — less time off the throttle through the gears",        speed: 1.01, accel: 1.09, braking: 1.02, visual: { strakes: 4, fin: 1, strakeH: 0.16, finSY: 0.19, finSZ: 0.26, casing: 2, louvres: 3, heat: 0 , heatFins: 4, ribs: 1}, visualTier: 2 },
      { id: "titanium_case", label: "Titanium Case",  cost: 150, desc: "Titanium bellhousing — stiff, light, and kind to the rear suspension mounts", speed: 1.03, accel: 1.09, cornering: 1.02, braking: 1.03, visual: { strakes: 5, fin: 1, strakeH: 0.21, finSY: 0.20, finSZ: 0.34, casing: 3, louvres: 2, heat: 1, caseWidth: 0.86 , heatFins: 3, ribs: 2}, visualTier: 2 },
      { id: "sig_rb_shortcase", label: "Faenza Shortcase", cost: 210, teams: ["racingbulls"], tag: "SIGNATURE", equivalent: "seamless_shift",
        desc: "Racing Bulls signature compact casing — Seamless Shift performance with a taller crash fin", speed: 1.05, accel: 1.12, cornering: 1.02, braking: 1.04, visual: { strakes: 5, fin: 1, strakeH: 0.18, finSY: 0.24, finSZ: 0.30, casing: 2, louvres: 6, heat: 1 , heatFins: 2, ribs: 0}, visualTier: 2 },
      { id: "sig_ferrari_seamless", label: "Maranello Seamless", cost: 210, teams: ["ferrari"], tag: "SIGNATURE", equivalent: "seamless_shift",
        desc: "Ferrari signature shift package — Seamless Shift performance in a sculpted red-crackle casing", speed: 1.05, accel: 1.12, cornering: 1.02, braking: 1.04, visual: { strakes: 4, fin: 1, strakeH: 0.21, finSY: 0.16, finSZ: 0.38, casing: 3, louvres: 4, heat: 1 , heatFins: 3, ribs: 1}, visualTier: 2 },
      { id: "sig_williams_longshift", label: "Grove Longshift", cost: 40, teams: ["williams"], tag: "SIGNATURE", equivalent: "long_ratio",
        desc: "Williams signature top-speed stack — Long Ratio performance with a heat-wrapped slim case", speed: 1.04, accel: 0.97, braking: 0.98, visual: { strakes: 3, fin: 0, strakeH: 0.18, casing: 1, louvres: 0, heat: 1, caseWidth: 0.92 , heatFins: 4, ribs: 1}, visualTier: 1 },
      { id: "sig_mercedes_gbox", label: "Brackley Gearcase", cost: 90, teams: ["mercedes"], tag: "SIGNATURE", equivalent: "sequential_pro",
        desc: "Mercedes signature gearcase — Sequential Pro performance with a 4-strake diffuser", speed: 1.02, accel: 1.07, braking: 1.01, visual: { strakes: 4, fin: 1, strakeH: 0.163, finSY: 0.17, finSZ: 0.32, casing: 2, louvres: 3, heat: 1, caseWidth: 0.92 , heatFins: 0, ribs: 2}, visualTier: 2 },
      { id: "sig_mclaren_gbox", label: "Woking Gearcase", cost: 210, teams: ["mclaren"], tag: "SIGNATURE", equivalent: "seamless_shift",
        desc: "McLaren signature gearcase — Seamless Shift performance with a 5-strake diffuser", speed: 1.05, accel: 1.12, cornering: 1.02, braking: 1.04, visual: { strakes: 5, fin: 1, strakeH: 0.196, finSY: 0.18, finSZ: 0.36, casing: 2, louvres: 5, heat: 1, caseWidth: 0.96 , heatFins: 0, ribs: 1}, visualTier: 2 },
      { id: "sig_redbull_gbox", label: "Milton Keynes Gearcase", cost: 70, teams: ["redbull"], tag: "SIGNATURE", equivalent: "short_stack",
        desc: "Red Bull signature gearcase — Short Stack performance with a 4-strake diffuser", speed: 0.95, accel: 1.08, cornering: 1.03, braking: 1.05, visual: { strakes: 4, fin: 1, strakeH: 0.152, finSY: 0.11, finSZ: 0.22, casing: 2, louvres: 2, heat: 0, caseWidth: 1.02 , heatFins: 2, ribs: 2}, visualTier: 2 },
      { id: "sig_alpine_gbox", label: "Enstone Gearcase", cost: 50, teams: ["alpine"], tag: "SIGNATURE", equivalent: "close_ratio",
        desc: "Alpine signature gearcase — Close Ratio performance with a 2-strake diffuser", speed: 0.98, accel: 1.06, braking: 1.03, visual: { strakes: 2, fin: 0, strakeH: 0.135, casing: 1, louvres: 3, heat: 0, caseWidth: 1.08 , heatFins: 3, ribs: 1}, visualTier: 1 },
      { id: "sig_haas_gbox", label: "Kannapolis Gearcase", cost: 140, teams: ["haas"], tag: "SIGNATURE", equivalent: "carbon_case",
        desc: "Haas signature gearcase — Carbon Case performance with a 3-strake diffuser", speed: 1.02, accel: 1.08, cornering: 1.03, braking: 1.03, visual: { strakes: 3, fin: 1, strakeH: 0.2, finSY: 0.15, finSZ: 0.3, casing: 3, louvres: 1, heat: 1, caseWidth: 1.1 , heatFins: 4, ribs: 2}, visualTier: 2 },
      { id: "sig_audi_gbox", label: "Neuburg Gearcase", cost: 90, teams: ["audi"], tag: "SIGNATURE", equivalent: "sequential_pro",
        desc: "Audi signature gearcase — Sequential Pro performance with a 5-strake diffuser", speed: 1.02, accel: 1.07, braking: 1.01, visual: { strakes: 5, fin: 1, strakeH: 0.18, finSY: 0.17, finSZ: 0.32, casing: 2, louvres: 4, heat: 1, caseWidth: 1.12 , heatFins: 2, ribs: 2}, visualTier: 2 },
      { id: "sig_astonmartin_gbox", label: "Silverstone Gearcase", cost: 180, teams: ["astonmartin"], tag: "SIGNATURE", equivalent: "f1_spec",
        desc: "Aston Martin signature gearcase — F1 Spec performance with a 5-strake diffuser", speed: 1.04, accel: 1.10, cornering: 1.03, braking: 1.03, visual: { strakes: 5, fin: 1, strakeH: 0.224, finSY: 0.24, finSZ: 0.36, casing: 2, louvres: 6, heat: 1, caseWidth: 1.04, heatFins: 4, ribs: 2 }, visualTier: 2 },
      { id: "sig_cadillac_gbox", label: "Detroit Gearcase", cost: 140, teams: ["cadillac"], tag: "SIGNATURE", equivalent: "carbon_case",
        desc: "Cadillac signature gearcase — Carbon Case performance with a 3-strake diffuser", speed: 1.02, accel: 1.08, cornering: 1.03, braking: 1.03, visual: { strakes: 3, fin: 1, strakeH: 0.205, finSY: 0.15, finSZ: 0.3, casing: 3, louvres: 2, heat: 1, caseWidth: 1.16 }, visualTier: 2 },
    ],
  },
  {
    id: "fuel", label: "FUEL",
    // Fuel is MASS: energy density buys speed and accel, the charge carried
    // costs cornering and braking. The SIGNATURE-free rows sit at the ends of
    // that axis (quali_mix heavy, quick_fill / hydro_synth light) so the
    // category has a trade rather than every row at or above 1.00 on all
    // four stats. The six rows with SIGNATUREs are untouched.
    options: [
      { id: "standard",      label: "Standard",       cost:   0, desc: "Baseline pump-spec fuel — meets FIA minimum grade",                          visual: { cap: [0.55, 0.52, 0.6], flame: [1.15, 0.42, 0.14], fxFlame: [2.6, 1.05, 0.25], line: 1 }, visualTier: 1 },
      { id: "high_octane",   label: "High Octane",    cost:  45, desc: "Higher octane blend — cleaner combustion and accel improvement",             accel: 1.05, visual: {"cap": [1.5, 1.15, 0.18], "flame": [1.75, 1.4, 0.45], "fxFlame": [2.7, 2.1, 0.7]}, visualTier: 1 },
      { id: "biofuel",       label: "Biofuel 100",    cost:  50, desc: "FIA-sustainable 100% biofuel — consistent burn and slight braking gain",     accel: 1.03, braking: 1.04, visual: {"cap": [0.18, 1.35, 0.5], "flame": [0.35, 1.65, 0.42], "fxFlame": [1.7, 1.9, 0.55]}, visualTier: 1 },
      { id: "race_blend",    label: "Race Blend",     cost:  90, desc: "F1-regulation compound — refined energy density for speed and accel",        speed: 1.02, accel: 1.06, visual: {"cap": [1.6, 0.6, 0.14], "flame": [1.95, 0.72, 0.14], "fxFlame": [2.9, 1.1, 0.25]}, visualTier: 1 },
      { id: "quali_mix",     label: "Qualifying Mix", cost: 150, desc: "Maximum energy density — a heavy charge that flies down the straights and blunts the car everywhere else", speed: 1.07, accel: 1.08, cornering: 0.95, braking: 0.95, visual: { breather: 1,"cap": [0.95, 0.28, 1.5], "flame": [1.25, 0.35, 1.75], "fxFlame": [1.5, 1.7, 2.4], hatch: 1}, visualTier: 2 },
      { id: "custom_formula",label: "Custom Formula", cost: 210, desc: "Team-developed proprietary blend — marginal all-metric gains",               speed: 1.05, accel: 1.09, cornering: 1.02, braking: 1.02, visual: { breather: 2,"cap": [1.9, 0.25, 1.25], "flame": [1.85, 0.25, 1.4], "fxFlame": [2.6, 0.5, 2.1], vent: 1}, visualTier: 2 },
      { id: "efuel_dense",   label: "Dense E-Fuel",   cost: 175, desc: "Synthetic high-density blend — clean burn with balanced race performance",      speed: 1.04, accel: 1.08, braking: 1.03, visual: { cap: [0.12, 1.25, 1.65], flame: [0.25, 1.20, 1.95], fxFlame: [0.55, 1.75, 2.75] , hatch: 1}, visualTier: 2 },
      // Filler-hardware specs — the pit-lane coupling on the cover is the tell.
      { id: "quick_fill",    label: "Quick Fill",     cost:  60, desc: "Twin-coupling rig — start light and top up fast: agile and easy to stop, short of top end", speed: 0.99, accel: 1.05, cornering: 1.03, braking: 1.03, visual: { cap: [0.85, 0.86, 0.90], flame: [1.30, 0.95, 0.35], fxFlame: [2.4, 1.6, 0.6], line: 1, filler: 2 , hatch: 1, vent: 1}, visualTier: 1 },
      { id: "cold_blend",    label: "Cold Blend",     cost: 120, desc: "Chilled high-density charge — cleaner combustion, a broader torque plateau and a cooler rear end", speed: 1.03, accel: 1.06, cornering: 1.01, braking: 1.02, visual: { breather: 2, cap: [0.30, 0.80, 1.60], flame: [0.55, 0.95, 1.85], fxFlame: [1.1, 1.6, 2.7], line: 1, filler: 1 , hatch: 1}, visualTier: 1 },
      { id: "hydro_synth",   label: "Hydro-Synth",    cost: 190, desc: "Hydrogen-derived synthetic — the lightest charge on the shelf and the coolest burn, if you can live without the top end",   speed: 1.03, accel: 1.08, cornering: 1.02, braking: 1.06, visual: { breather: 2, cap: [1.75, 1.60, 0.30], flame: [1.90, 1.75, 0.40], fxFlame: [2.9, 2.5, 0.7], line: 2, filler: 1, hatch: 1, vent: 1 }, visualTier: 2 },
      { id: "sig_alpine_efuel", label: "Viry E-Fuel", cost: 175, teams: ["alpine"], tag: "SIGNATURE", equivalent: "efuel_dense",
        desc: "Alpine signature synthetic blend — Dense E-Fuel performance with a blue-pink burn", speed: 1.04, accel: 1.08, braking: 1.03, visual: { breather: 1, cap: [0.10, 0.72, 1.85], flame: [0.65, 0.32, 1.95], fxFlame: [0.85, 0.65, 2.85], line: 2 , hatch: 1}, visualTier: 2 },
      { id: "sig_haas_blend", label: "Kannapolis Blend", cost: 90, teams: ["haas"], tag: "SIGNATURE", equivalent: "race_blend",
        desc: "Haas signature race fuel — Race Blend performance with a stars-and-stripes red burn", speed: 1.02, accel: 1.06, visual: { cap: [1.70, 0.20, 0.15], flame: [1.90, 0.30, 0.25], fxFlame: [2.90, 0.60, 0.40], line: 2 , hatch: 1}, visualTier: 1 },
      { id: "sig_mercedes_fuel", label: "Brackley Blend", cost: 175, teams: ["mercedes"], tag: "SIGNATURE", equivalent: "efuel_dense",
        desc: "Mercedes signature blend — Dense E-Fuel performance with a quick-fill coupling", speed: 1.04, accel: 1.08, braking: 1.03, visual: { breather: 1, cap: [0, 1.2, 1.12], flame: [0.35, 1.55, 1.45], fxFlame: [0.525, 2.325, 2.175], filler: 1, line: 1 , hatch: 1, vent: 1}, visualTier: 2 },
      { id: "sig_ferrari_fuel", label: "Maranello Blend", cost: 90, teams: ["ferrari"], tag: "SIGNATURE", equivalent: "race_blend",
        desc: "Ferrari signature blend — Race Blend performance with twin filler couplings", speed: 1.02, accel: 1.06, visual: { breather: 2, cap: [1.52, 0.08, 0.064], flame: [1.9, 0.3, 0.15], fxFlame: [2.85, 0.45, 0.225], filler: 2, line: 2 , vent: 1}, visualTier: 1 },
      { id: "sig_mclaren_fuel", label: "Woking Blend", cost: 175, teams: ["mclaren"], tag: "SIGNATURE", equivalent: "efuel_dense",
        desc: "McLaren signature blend — Dense E-Fuel performance with a quick-fill coupling", speed: 1.04, accel: 1.08, braking: 1.03, visual: { breather: 1, cap: [1.6, 0.8, 0], flame: [1.95, 0.95, 0.1], fxFlame: [2.925, 1.425, 0.15], filler: 1, line: 2 , hatch: 1}, visualTier: 2 },
      { id: "sig_redbull_fuel", label: "Milton Keynes Blend", cost: 90, teams: ["redbull"], tag: "SIGNATURE", equivalent: "race_blend",
        desc: "Red Bull signature blend — Race Blend performance with a single-point filler", speed: 1.02, accel: 1.06, visual: { cap: [1.52, 1.248, 0], flame: [1.85, 1.45, 0.2], fxFlame: [2.775, 2.175, 0.3], filler: 0, line: 1 , hatch: 1}, visualTier: 1 },
      { id: "sig_racingbulls_fuel", label: "Faenza Blend", cost: 45, teams: ["racingbulls"], tag: "SIGNATURE", equivalent: "high_octane",
        desc: "Racing Bulls signature blend — High Octane performance with a quick-fill coupling", accel: 1.05, visual: { breather: 1, cap: [0.32, 0.48, 1.52], flame: [0.45, 0.6, 1.95], fxFlame: [0.675, 0.9, 2.925], filler: 1, line: 1 , hatch: 1}, visualTier: 1 },
      { id: "sig_williams_fuel", label: "Grove Blend", cost: 45, teams: ["williams"], tag: "SIGNATURE", equivalent: "high_octane",
        desc: "Williams signature blend — High Octane performance with a single-point filler", accel: 1.05, visual: {cap: [0.32, 0.88, 1.52], flame: [0.55, 1.05, 1.9], fxFlame: [0.825, 1.575, 2.85], filler: 2, line: 1, vent: 1, breather: 1, hatch: 1}, visualTier: 1 },
      { id: "sig_audi_fuel", label: "Neuburg Blend", cost: 50, teams: ["audi"], tag: "SIGNATURE", equivalent: "biofuel",
        desc: "Audi signature blend — Biofuel 100 performance with a quick-fill coupling", accel: 1.03, braking: 1.04, visual: { breather: 2, cap: [1.568, 0.448, 0.08], flame: [2, 0.45, 0.15], fxFlame: [3, 0.675, 0.225], filler: 1, line: 2 }, visualTier: 1 },
      { id: "sig_astonmartin_fuel", label: "Silverstone Blend", cost: 210, teams: ["astonmartin"], tag: "SIGNATURE", equivalent: "custom_formula",
        desc: "Aston Martin signature blend — Custom Formula performance with twin filler couplings", speed: 1.05, accel: 1.09, cornering: 1.02, braking: 1.02, visual: { breather: 2, cap: [1.152, 1.408, 0.176], flame: [1.1, 1.9, 0.3], fxFlame: [1.65, 2.85, 0.45], filler: 2, line: 2 }, visualTier: 2 },
      { id: "sig_cadillac_fuel", label: "Detroit Blend", cost: 175, teams: ["cadillac"], tag: "SIGNATURE", equivalent: "efuel_dense",
        desc: "Cadillac signature blend — Dense E-Fuel performance with twin filler couplings", speed: 1.04, accel: 1.08, braking: 1.03, visual: { breather: 1, cap: [1.36, 1.12, 0.512], flame: [1.8, 1.35, 0.5], fxFlame: [2.7, 2.025, 0.75], filler: 2, line: 1 }, visualTier: 2 },
    ],
  },
  {
    id: "exhaust", label: "EXHAUST",
    // The blown floor is the cornering column: flared exits buy cornering
    // with top end (megaphone 1.02, flared_gate 1.05) and the shielded exit is
    // the opposite rung (no blowing, 1.06 speed). `sig_williams_exh` clones
    // megaphone and was propagated with it.
    options: [
      { id: "stock",      label: "Stock",          cost:   0, desc: "Factory tailpipe, sized to the power unit's own plumbing",                    visual: { pipes: null, bore: 1, flare: 0, wastegate: 0, wrap: 0 , shield: 1}, visualTier: 1 },
      { id: "sport_cat",  label: "Sport Cat",      cost:  30, desc: "Freer catalyst section — a little less back-pressure everywhere",             accel: 1.03, visual: {pipes: null, bore: 1.12, flare: 0.5, wastegate: 0, wrap: 0, shield: 1}, visualTier: 1 },
      { id: "free_flow",  label: "Free Flow",      cost:  60, desc: "Straight-through primaries — cleaner scavenging high in the rev range",       speed: 1.03, accel: 1.03, braking: 0.99, visual: { pipes: null, bore: 1.18, flare: 0, wastegate: 0, wrap: 1 , lip: 1, shield: 1}, visualTier: 1 },
      { id: "megaphone",  label: "Megaphone",      cost:  90, desc: "Flared megaphone exit aimed at the floor edge — mid-range and a little blown downforce, no top end", speed: 1.00, accel: 1.05, cornering: 1.02, braking: 1.02, visual: { pipes: 1, bore: 1.22, flare: 1, wastegate: 0, wrap: 0 , lip: 2, shield: 1}, visualTier: 2 },
      { id: "twin_gate",  label: "Twin Wastegate", cost: 110, desc: "Twin wastegate stacks — sharper boost response out of slow corners",          speed: 1.01, accel: 1.07, braking: 1.03, visual: { pipes: null, bore: 1.10, flare: 0, wastegate: 2, wrap: 1 , lip: 1}, visualTier: 2 },
      { id: "inconel",    label: "Inconel Race",   cost: 120, desc: "Thin-wall Inconel system — mass saving with a broad power gain",              speed: 1.04, accel: 1.05, braking: 1.01, visual: { pipes: 3, bore: 1.05, flare: 0, wastegate: 0, wrap: 1 , lip: 2, shield: 1}, visualTier: 2 },
      { id: "tri_exit",   label: "Tri-Exit",       cost: 155, desc: "Three-pipe exit — the classic scavenging layout in race trim",                speed: 1.04, accel: 1.07, braking: 1.03, visual: { pipes: 3, bore: 1.16, flare: 0.5, wastegate: 2, wrap: 0 , lip: 1, shield: 1}, visualTier: 2 },
      { id: "wrapped_single", label: "Wrapped Single",  cost:  45, desc: "Single wrapped pipe — heat kept off the bodywork, modest gain", accel: 1.04, braking: 1.01, visual: { pipes: 1, bore: 1.04, flare: 0.5, wastegate: 0, wrap: 1, lip: 2, shield: 1 }, visualTier: 1 },
      { id: "flared_gate",   label: "Flared Wastegate", cost: 125, desc: "Wastegate plume dumped across the diffuser edge — the blown floor, paid for in top end", speed: 1.00, accel: 1.05, cornering: 1.05, braking: 1.02, visual: { pipes: 1, bore: 1.206, flare: 1, wastegate: 2, wrap: 0, lip: 2, shield: 1 }, visualTier: 2 },
      { id: "shielded_tri",  label: "Shielded Tri-Exit", cost: 185, desc: "Three shielded exits on a wide bore — heat kept OFF the floor, so all of it goes to top end", speed: 1.06, accel: 1.06, visual: { pipes: 3, bore: 1.378, flare: 0.5, wastegate: 2, wrap: 1, lip: 2, shield: 1 }, visualTier: 2 },
      { id: "hyper_scav", label: "Hyper Scavenge", cost: 200, desc: "Pulse-tuned scavenging — peak flow at every point in the rev range",          speed: 1.05, accel: 1.08, braking: 1.04, visual: { pipes: 3, bore: 1.30, flare: 1, wastegate: 2, wrap: 1 }, visualTier: 2 },
      { id: "sig_mercedes_exh", label: "Brackley Exhaust", cost: 60, teams: ["mercedes"], tag: "SIGNATURE", equivalent: "free_flow",
        desc: "Mercedes signature exhaust — Free Flow performance with a flared megaphone tip", speed: 1.03, accel: 1.03, braking: 0.99, visual: { pipes: 1, bore: 1.121, flare: 0.5, wastegate: 0, wrap: 0 , lip: 2, shield: 1}, visualTier: 1 },
      { id: "sig_ferrari_exh", label: "Maranello Exhaust", cost: 155, teams: ["ferrari"], tag: "SIGNATURE", equivalent: "tri_exit",
        desc: "Ferrari signature exhaust — Tri-Exit performance with a three-pipe exit", speed: 1.04, accel: 1.07, braking: 1.03, visual: { pipes: 3, bore: 1.206, flare: 1, wastegate: 2, wrap: 1 , lip: 1}, visualTier: 2 },
      { id: "sig_mclaren_exh", label: "Woking Exhaust", cost: 120, teams: ["mclaren"], tag: "SIGNATURE", equivalent: "inconel",
        desc: "McLaren signature exhaust — Inconel Race performance with a three-pipe exit", speed: 1.04, accel: 1.05, braking: 1.01, visual: { pipes: 3, bore: 1.029, flare: 0.5, wastegate: 2, wrap: 0 , shield: 1}, visualTier: 2 },
      { id: "sig_redbull_exh", label: "Milton Keynes Exhaust", cost: 110, teams: ["redbull"], tag: "SIGNATURE", equivalent: "twin_gate",
        desc: "Red Bull signature exhaust — Twin Wastegate performance with a three-pipe exit", speed: 1.01, accel: 1.07, braking: 1.03, visual: { pipes: 3, bore: 1.122, flare: 1, wastegate: 0, wrap: 0 , lip: 2}, visualTier: 2 },
      { id: "sig_alpine_exh", label: "Enstone Exhaust", cost: 30, teams: ["alpine"], tag: "SIGNATURE", equivalent: "sport_cat",
        desc: "Alpine signature exhaust — Sport Cat performance with a flared megaphone tip", accel: 1.03, visual: { pipes: 1, bore: 1.091, flare: 0.5, wastegate: 2, wrap: 1 , lip: 2, shield: 1}, visualTier: 1 },
      { id: "sig_racingbulls_exh", label: "Faenza Exhaust", cost: 60, teams: ["racingbulls"], tag: "SIGNATURE", equivalent: "free_flow",
        desc: "Racing Bulls signature exhaust — Free Flow performance with a single tuned pipe", speed: 1.03, accel: 1.03, braking: 0.99, visual: { pipes: 1, bore: 1.145, flare: 0, wastegate: 0, wrap: 0 , lip: 2}, visualTier: 1 },
      { id: "sig_haas_exh", label: "Kannapolis Exhaust", cost: 0, teams: ["haas"], tag: "SIGNATURE", equivalent: "stock",
        desc: "Haas signature exhaust — Stock performance with a single tuned pipe", visual: { pipes: 1, bore: 1.05, flare: 0, wastegate: 0, wrap: 1 , lip: 2, shield: 1}, visualTier: 1 },
      { id: "sig_williams_exh", label: "Grove Exhaust", cost: 90, teams: ["williams"], tag: "SIGNATURE", equivalent: "megaphone",
        desc: "Williams signature exhaust — Megaphone performance with a single tuned pipe", speed: 1.00, accel: 1.05, cornering: 1.02, braking: 1.02, visual: { pipes: 1, bore: 1.135, flare: 0, wastegate: 0, wrap: 0 }, visualTier: 2 },
      { id: "sig_audi_exh", label: "Neuburg Exhaust", cost: 110, teams: ["audi"], tag: "SIGNATURE", equivalent: "twin_gate",
        desc: "Audi signature exhaust — Twin Wastegate performance with a three-pipe exit", speed: 1.01, accel: 1.07, braking: 1.03, visual: { pipes: 3, bore: 1.133, flare: 1, wastegate: 2, wrap: 1 }, visualTier: 2 },
      { id: "sig_astonmartin_exh", label: "Silverstone Exhaust", cost: 120, teams: ["astonmartin"], tag: "SIGNATURE", equivalent: "inconel",
        desc: "Aston Martin signature exhaust — Inconel Race performance with a three-pipe exit", speed: 1.04, accel: 1.05, braking: 1.01, visual: { pipes: 3, bore: 1.04, flare: 1, wastegate: 0, wrap: 0 }, visualTier: 2 },
      { id: "sig_cadillac_exh", label: "Detroit Exhaust", cost: 200, teams: ["cadillac"], tag: "SIGNATURE", equivalent: "hyper_scav",
        desc: "Cadillac signature exhaust — Hyper Scavenge performance with a flared megaphone tip", speed: 1.05, accel: 1.08, braking: 1.04, visual: { pipes: 1, bore: 1.378, flare: 0.5, wastegate: 2, wrap: 1 }, visualTier: 2 },
    ],
  },
  {
    id: "floor", label: "FLOOR",
    options: [
      { id: "standard",    label: "Standard",       cost:   0, desc: "Regulation floor with the stock fence array",                                 visual: { fences: 5, fenceH: 1, skid: 0, edgeLip: 0 }, visualTier: 1 },
      { id: "stripped",    label: "Stripped",       cost:   0, desc: "Fences removed for minimum drag — quick in a straight line, loose in a corner", speed: 1.04, accel: 0.97, cornering: 0.90, visual: { fences: 0, fenceH: 1, skid: 0, edgeLip: 0 }, visualTier: 0 },
      { id: "sealed_edge", label: "Sealed Edge",    cost:  55, desc: "Sealed floor edge — steadier underbody load through medium-speed corners",     speed: 0.99, accel: 1.02, cornering: 1.06, visual: { fences: 4, fenceH: 1.15, skid: 0, edgeLip: 0.5 , gurney: 1}, visualTier: 1 },
      { id: "ti_skids",    label: "Titanium Skids", cost:  60, desc: "Titanium skid blocks — run the plank lower without wearing it through",        accel: 1.01, cornering: 1.04, braking: 1.04, visual: { fences: 5, fenceH: 1, skid: 2, edgeLip: 0 }, visualTier: 1 },
      { id: "fence_array", label: "Fence Array",    cost:  90, desc: "Full fence array — keeps the floor sealed when the car is yawed",              speed: 0.98, accel: 1.03, cornering: 1.10, visual: { fences: 6, fenceH: 1.3, skid: 0, edgeLip: 0.3 , plank: 1, gurney: 1, scroll: 1}, visualTier: 2 },
      { id: "edge_wing",   label: "Edge Wing",      cost: 125, desc: "Floor-edge wing — extra load for a modest drag penalty",                       speed: 0.98, accel: 1.04, cornering: 1.13, braking: 1.02, visual: { fences: 5, fenceH: 1.2, skid: 1, edgeLip: 1 , gurney: 1}, visualTier: 2 },
      { id: "step_plank",    label: "Stepped Plank",   cost:  35, desc: "Thicker plank on a stepped reference — kinder to a bumpy kerb, a touch of drag", speed: 0.99, accel: 1.01, cornering: 1.03, braking: 1.02, visual: { fences: 4, fenceH: 1.05, skid: 1, edgeLip: 0.3, plank: 1 }, visualTier: 1 },
      { id: "gurney_edge",   label: "Gurney Edge",     cost:  80, desc: "A gurney along the floor edge — cheap rear load at the cost of straight-line speed", speed: 0.97, accel: 1.03, cornering: 1.09, visual: { fences: 5, fenceH: 1.24, skid: 1, edgeLip: 0.55, gurney: 1, plank: 1 }, visualTier: 2 },
      { id: "scroll_floor",  label: "Scrolled Floor",  cost: 145, desc: "Rolled outer floor with a scrolled leading edge — high load, fragile in dirty air", speed: 0.96, accel: 1.05, cornering: 1.14, braking: 1.05, visual: { fences: 6, fenceH: 1.40, skid: 2, edgeLip: 0.75, scroll: 1, gurney: 1, plank: 1 }, visualTier: 2 },
      { id: "venturi",     label: "Venturi Floor",  cost: 190, desc: "Full venturi package — maximum underbody load at every speed",                 speed: 0.96, accel: 1.07, cornering: 1.16, braking: 1.04, visual: { fences: 6, fenceH: 1.45, skid: 2, edgeLip: 1 , plank: 1, scroll: 1}, visualTier: 2 },
      { id: "sig_mercedes_floor", label: "Brackley Floor", cost: 125, teams: ["mercedes"], tag: "SIGNATURE", equivalent: "edge_wing",
        desc: "Mercedes signature floor — Edge Wing performance with a 5-fence floor edge on titanium skids", speed: 0.98, accel: 1.04, cornering: 1.13, braking: 1.02, visual: { fences: 5, fenceH: 1.164, skid: 1, edgeLip: 1 , plank: 1}, visualTier: 2 },
      { id: "sig_ferrari_floor", label: "Maranello Floor", cost: 190, teams: ["ferrari"], tag: "SIGNATURE", equivalent: "venturi",
        desc: "Ferrari signature floor — Venturi Floor performance with a 6-fence floor edge on titanium skids", speed: 0.96, accel: 1.07, cornering: 1.16, braking: 1.04, visual: { fences: 6, fenceH: 1.523, skid: 2, edgeLip: 0.75, plank: 1, gurney: 1 }, visualTier: 2 },
      { id: "sig_mclaren_floor", label: "Woking Floor", cost: 190, teams: ["mclaren"], tag: "SIGNATURE", equivalent: "venturi",
        desc: "McLaren signature floor — Venturi Floor performance with a 6-fence floor edge on titanium skids", speed: 0.96, accel: 1.07, cornering: 1.16, braking: 1.04, visual: { fences: 6, fenceH: 1.378, skid: 1, edgeLip: 1 , plank: 1}, visualTier: 2 },
      { id: "sig_redbull_floor", label: "Milton Keynes Floor", cost: 90, teams: ["redbull"], tag: "SIGNATURE", equivalent: "fence_array",
        desc: "Red Bull signature floor — Fence Array performance with a 6-fence floor edge on titanium skids", speed: 0.98, accel: 1.03, cornering: 1.10, visual: { fences: 6, fenceH: 1.391, skid: 2, edgeLip: 0.55 , plank: 1}, visualTier: 2 },
      { id: "sig_alpine_floor", label: "Enstone Floor", cost: 55, teams: ["alpine"], tag: "SIGNATURE", equivalent: "sealed_edge",
        desc: "Alpine signature floor — Sealed Edge performance with a 4-fence floor edge on titanium skids", speed: 0.99, accel: 1.02, cornering: 1.06, visual: { fences: 4, fenceH: 1.173, skid: 1, edgeLip: 0.5 , plank: 1, gurney: 1}, visualTier: 1 },
      { id: "sig_racingbulls_floor", label: "Faenza Floor", cost: 60, teams: ["racingbulls"], tag: "SIGNATURE", equivalent: "ti_skids",
        desc: "Racing Bulls signature floor — Titanium Skids performance with a 5-fence floor edge", accel: 1.01, cornering: 1.04, braking: 1.04, visual: { fences: 5, fenceH: 0.98, skid: 0, edgeLip: 0 , gurney: 1, scroll: 1}, visualTier: 1 },
      { id: "sig_haas_floor", label: "Kannapolis Floor", cost: 0, teams: ["haas"], tag: "SIGNATURE", equivalent: "stripped",
        desc: "Haas signature floor — Stripped performance with bare titanium skids and no fences", speed: 1.04, accel: 0.97, cornering: 0.90, visual: { fences: 0, fenceH: 1.04, skid: 2, edgeLip: 0 , plank: 1, gurney: 1}, visualTier: 0 },
      { id: "sig_williams_floor", label: "Grove Floor", cost: 0, teams: ["williams"], tag: "SIGNATURE", equivalent: "stripped",
        desc: "Williams signature floor — Stripped performance with a stripped floor edge", speed: 1.04, accel: 0.97, cornering: 0.90, visual: { fences: 4, fenceH: 0.94, skid: 1, edgeLip: 0.3, plank: 1 }, visualTier: 0 },
      { id: "sig_audi_floor", label: "Neuburg Floor", cost: 55, teams: ["audi"], tag: "SIGNATURE", equivalent: "sealed_edge",
        desc: "Audi signature floor — Sealed Edge performance with a 5-fence floor edge on titanium skids", speed: 0.99, accel: 1.02, cornering: 1.06, visual: { fences: 5, fenceH: 1.253, skid: 2, edgeLip: 0.75 }, visualTier: 1 },
      { id: "sig_astonmartin_floor", label: "Silverstone Floor", cost: 125, teams: ["astonmartin"], tag: "SIGNATURE", equivalent: "edge_wing",
        desc: "Aston Martin signature floor — Edge Wing performance with a 6-fence floor edge on titanium skids", speed: 0.98, accel: 1.04, cornering: 1.13, braking: 1.02, visual: { fences: 6, fenceH: 1.236, skid: 1, edgeLip: 1 }, visualTier: 2 },
      { id: "sig_cadillac_floor", label: "Detroit Floor", cost: 90, teams: ["cadillac"], tag: "SIGNATURE", equivalent: "fence_array",
        desc: "Cadillac signature floor — Fence Array performance with a 5-fence floor edge on titanium skids", speed: 0.98, accel: 1.03, cornering: 1.10, visual: { fences: 5, fenceH: 1.313, skid: 2, edgeLip: 0.3 }, visualTier: 2 },
    ],
  },
  {
    id: "cockpit", label: "COCKPIT",
    options: [
      { id: "standard",   label: "Standard",      cost:   0, desc: "Regulation halo and cockpit surround",                                       visual: { haloBlade: 0, haloWing: 0, camPods: 0, screen: 0 }, visualTier: 1 },
      { id: "faired_halo",label: "Faired Halo",   cost:  40, desc: "Aero fairing over the halo — cleans up the flow to the airbox",              speed: 1.04, cornering: 0.99, visual: {halo: 1, haloBlade: 1, haloWing: 0, camPods: 0, screen: 0, headrest: 1}, visualTier: 1 },
      { id: "twin_cam",   label: "Twin T-Cam",    cost:  30, desc: "Second camera pod — broadcast spec, and a touch more roll-hoop drag",        speed: 0.98, cornering: 1.03, visual: {headrest: 1, haloBlade: 0, haloWing: 0, camPods: 2, screen: 0, mirror: 1.28}, visualTier: 1 },
      { id: "deflector",  label: "Deflector",     cost:  60, desc: "Cockpit deflector — steadier air over the driver at speed",                  speed: 1.03, cornering: 1.01, braking: 1.03, visual: {headrest: 1, haloBlade: 1, haloWing: 0, camPods: 1, screen: 1, mirror: 1.18}, visualTier: 2 },
      { id: "halo_wing",  label: "Halo Wing",     cost: 110, desc: "Upper halo flap — real downforce from the cockpit structure itself",         speed: 0.98, cornering: 1.10, braking: 1.02, visual: {headrest: 2, haloBlade: 1, haloWing: 1, camPods: 1, screen: 0, mirror: 0.9}, visualTier: 2 },
      { id: "full_shroud",label: "Full Shroud",   cost: 160, desc: "Fully faired halo with flap and deflector — the complete cockpit package",   speed: 1.02, accel: 1.02, cornering: 1.12, braking: 1.03, visual: {halo: 2, headrest: 2, haloBlade: 2, haloWing: 1, camPods: 2, screen: 1, mirror: 1.32}, visualTier: 2 },
      { id: "open_cell",     label: "Open Cell",       cost:  20, desc: "Stripped surround — the lightest legal cockpit, no shrouding at all", accel: 1.04, cornering: 0.97, visual: {halo: 1, headrest: 0, haloBlade: 0, haloWing: 0, camPods: 1, screen: 0}, visualTier: 0 },
      { id: "twin_pod_screen", label: "Twin Pod Screen", cost:  75, desc: "Twin camera pods either side of a raised screen — steadier air over the airbox", speed: 1.02, cornering: 1.05, visual: {halo: 1, headrest: 1, haloBlade: 1, haloWing: 0, camPods: 2, screen: 1, mirror: 1.22}, visualTier: 1 },
      { id: "winged_shroud", label: "Winged Shroud",   cost: 140, desc: "Faired halo with an upper flap and a deep headrest — the most worked cockpit on the grid", speed: 1.04, cornering: 1.09, braking: 1.03, visual: { halo: 2, headrest: 2, haloBlade: 2, haloWing: 1, camPods: 1, screen: 1 }, visualTier: 2 },
      { id: "halo_fence", label: "Fenced Halo",   cost:  85, desc: "Crest vanes along the halo crown — conditions the flow into the airbox",   speed: 0.97, cornering: 1.08, visual: {halo: 2, headrest: 1, haloBlade: 0, haloWing: 0, camPods: 0, screen: 0, mirror: 0.88}, visualTier: 2 },
      { id: "sig_mercedes_cpit", label: "Brackley Cockpit", cost: 110, teams: ["mercedes"], tag: "SIGNATURE", equivalent: "halo_wing",
        desc: "Mercedes signature cockpit — Halo Wing performance with a bladed halo", speed: 0.98, cornering: 1.10, braking: 1.02, visual: {halo: 1, headrest: 1, haloBlade: 2, haloWing: 1, camPods: 1, screen: 0, mirror: 1.3}, visualTier: 2 },
      { id: "sig_ferrari_cpit", label: "Maranello Cockpit", cost: 160, teams: ["ferrari"], tag: "SIGNATURE", equivalent: "full_shroud",
        desc: "Ferrari signature cockpit — Full Shroud performance with a fully faired halo and an upper flap", speed: 1.02, accel: 1.02, cornering: 1.12, braking: 1.03, visual: {halo: 2, headrest: 1, haloBlade: 2, haloWing: 1, camPods: 0, screen: 0, mirror: 0.87}, visualTier: 2 },
      { id: "sig_mclaren_cpit", label: "Woking Cockpit", cost: 110, teams: ["mclaren"], tag: "SIGNATURE", equivalent: "halo_wing",
        desc: "McLaren signature cockpit — Halo Wing performance with a bladed halo and an upper flap", speed: 0.98, cornering: 1.10, braking: 1.02, visual: {halo: 0, headrest: 2, haloBlade: 1, haloWing: 1, camPods: 2, screen: 1, mirror: 1.24}, visualTier: 2 },
      { id: "sig_redbull_cpit", label: "Milton Keynes Cockpit", cost: 60, teams: ["redbull"], tag: "SIGNATURE", equivalent: "deflector",
        desc: "Red Bull signature cockpit — Deflector performance with an upper halo flap", speed: 1.03, cornering: 1.01, braking: 1.03, visual: {halo: 1, headrest: 2, haloBlade: 0, haloWing: 1, camPods: 1, screen: 0, mirror: 0.92}, visualTier: 2 },
      { id: "sig_alpine_cpit", label: "Enstone Cockpit", cost: 40, teams: ["alpine"], tag: "SIGNATURE", equivalent: "faired_halo",
        desc: "Alpine signature cockpit — Faired Halo performance with a bladed halo and an upper flap", speed: 1.04, cornering: 0.99, visual: {halo: 0, headrest: 1, haloBlade: 1, haloWing: 1, camPods: 0, screen: 0, mirror: 1.14}, visualTier: 1 },
      { id: "sig_racingbulls_cpit", label: "Faenza Cockpit", cost: 30, teams: ["racingbulls"], tag: "SIGNATURE", equivalent: "twin_cam",
        desc: "Racing Bulls signature cockpit — Twin T-Cam performance with a bare halo", speed: 0.98, cornering: 1.03, visual: {halo: 1, headrest: 0, haloBlade: 0, haloWing: 0, camPods: 1, screen: 1, mirror: 1.35}, visualTier: 1 },
      { id: "sig_haas_cpit", label: "Kannapolis Cockpit", cost: 0, teams: ["haas"], tag: "SIGNATURE", equivalent: "standard",
        desc: "Haas signature cockpit — Standard performance with an upper halo flap", visual: {halo: 0, headrest: 1, haloBlade: 0, haloWing: 1, camPods: 0, screen: 0, mirror: 0.85}, visualTier: 1 },
      { id: "sig_williams_cpit", label: "Grove Cockpit", cost: 40, teams: ["williams"], tag: "SIGNATURE", equivalent: "faired_halo",
        desc: "Williams signature cockpit — Faired Halo performance with a bladed halo", speed: 1.04, cornering: 0.99, visual: {halo: 2, headrest: 0, haloBlade: 1, haloWing: 0, camPods: 2, screen: 1, mirror: 1.2}, visualTier: 1 },
      { id: "sig_audi_cpit", label: "Neuburg Cockpit", cost: 60, teams: ["audi"], tag: "SIGNATURE", equivalent: "deflector",
        desc: "Audi signature cockpit — Deflector performance with a fully faired halo", speed: 1.03, cornering: 1.01, braking: 1.03, visual: {halo: 2, headrest: 2, haloBlade: 2, haloWing: 1, camPods: 2, screen: 0, mirror: 0.95}, visualTier: 2 },
      { id: "sig_astonmartin_cpit", label: "Silverstone Cockpit", cost: 160, teams: ["astonmartin"], tag: "SIGNATURE", equivalent: "full_shroud",
        desc: "Aston Martin signature cockpit — Full Shroud performance with a fully faired halo and an upper flap", speed: 1.02, accel: 1.02, cornering: 1.12, braking: 1.03, visual: {halo: 1, headrest: 1, haloBlade: 2, haloWing: 1, camPods: 1, screen: 1, mirror: 1.26}, visualTier: 2 },
      { id: "sig_cadillac_cpit", label: "Detroit Cockpit", cost: 30, teams: ["cadillac"], tag: "SIGNATURE", equivalent: "twin_cam",
        desc: "Cadillac signature cockpit — Twin T-Cam performance with a bladed halo", speed: 0.98, cornering: 1.03, visual: {halo: 0, headrest: 2, haloBlade: 1, haloWing: 0, camPods: 1, screen: 0, mirror: 1.08}, visualTier: 1 },
    ],
  },
  {
    id: "wheels", label: "WHEELS",
    options: [
      { id: "standard",  label: "Standard",     cost:   0, desc: "Regulation 18-inch rim with the stock aero cover",                          visual: { spokes: 0, tape: 0, dish: 0, nut: null }, visualTier: 1 },
      { id: "spoked",    label: "Spoked Rim",   cost:  40, desc: "Visible spoke blades — a little more brake cooling through the rim face",   speed: 0.99, accel: 1.02, braking: 1.05, visual: { spokes: 6, tape: 0, dish: 0, nut: [0.85, 0.72, 0.10] }, visualTier: 1 },
      { id: "dished",    label: "Dished Cover", cost:  60, desc: "Recessed cover face — cleaner flow off the wheel at speed",                 speed: 1.04, cornering: 1.01, braking: 0.98, visual: {spokes: 0, tape: 0, dish: 1, nut: [0.7, 0.72, 0.78], gunNut: 1, deflector: 1}, visualTier: 1 },
      { id: "taped",     label: "Taped Rim",    cost:  50, desc: "Banded rim shoulder — seals the bead and marks the set at a glance",        speed: 1.01, cornering: 1.05, braking: 0.99, visual: {spokes: 4, tape: 1, dish: 0, nut: [0.95, 0.2, 0.15], gunNut: 1}, visualTier: 1 },
      { id: "mag_forged",label: "Forged Mag",   cost: 110, desc: "Forged magnesium rim — real unsprung mass saved at every corner",           accel: 1.07, cornering: 1.03, braking: 1.06, visual: { deflector: 1, spokes: 8, tape: 0, dish: 1, nut: [0.60, 0.55, 0.30] }, visualTier: 2 },
      { id: "aero_disc", label: "Aero Disc",    cost: 130, desc: "Fully dished aero disc — top speed at the cost of brake cooling",           speed: 1.07, cornering: 1.02, braking: 0.95, visual: { deflector: 1, spokes: 0, tape: 1, dish: 2, nut: [0.15, 0.60, 0.95] , gunNut: 1}, visualTier: 2 },
      { id: "works_rim", label: "Works Rim",    cost: 170, desc: "Works-spec rim package — the complete wheel, and it looks it",              speed: 1.04, accel: 1.06, cornering: 1.06, braking: 1.05, visual: { deflector: 2, spokes: 6, tape: 1, dish: 2, nut: [0.98, 0.62, 0.05] , gunNut: 1}, visualTier: 2 },
      { id: "open_spoke",    label: "Open Spoke",      cost:  35, desc: "Eight open spokes — brake cooling at the price of a little wake", speed: 0.98, braking: 1.06, visual: { spokes: 8, tape: 0, dish: 0, gunNut: 1, deflector: 0 }, visualTier: 1 },
      // The SPOKED half of the aero_disc pair (it was an exact geometry clone
      // 45 cr apart). car3d paints rim tape in `nut` and falls back to the
      // tyre-band colour, so a taped rim needs a nut colour or it is a black
      // band on black rubber.
      { id: "taped_dish",    label: "Taped Dish",      cost:  85, desc: "Taped spokes over a dished face — clean outwash, runs the brakes hotter", speed: 1.05, cornering: 1.04, braking: 0.96, visual: { spokes: 8, tape: 1, dish: 1, gunNut: 1, deflector: 0, nut: [0.90, 0.86, 0.30] }, visualTier: 2 },
      { id: "deflector_max", label: "Deflector Max",   cost: 155, desc: "Full deflector set over a taped rim — the most aero wheel available", speed: 1.05, cornering: 1.10, braking: 0.98, visual: { spokes: 0, tape: 1, dish: 1, gunNut: 1, deflector: 2, nut: [0.55, 0.58, 0.66] }, visualTier: 2 },
      { id: "deflector_kit", label: "Deflector Kit", cost: 100, desc: "Biplane over-wheel deflectors with endplates — tames the front tyre wake", speed: 0.98, cornering: 1.08, braking: 1.03, visual: { deflector: 2, spokes: 3, tape: 0, dish: 0, nut: [0.30, 0.85, 0.45], gunNut: 1 }, visualTier: 2 },
      { id: "sig_mercedes_rim", label: "Brackley Rim", cost: 110, teams: ["mercedes"], tag: "SIGNATURE", equivalent: "mag_forged",
        desc: "Mercedes signature rim — Forged Mag performance with a 7-spoke rim with a banded shoulder", accel: 1.07, cornering: 1.03, braking: 1.06, visual: { deflector: 1, spokes: 7, tape: 1, dish: 1, nut: [0, 0.75, 0.7] , gunNut: 1}, visualTier: 2 },
      { id: "sig_ferrari_rim", label: "Maranello Rim", cost: 170, teams: ["ferrari"], tag: "SIGNATURE", equivalent: "works_rim",
        desc: "Ferrari signature rim — Works Rim performance with a plain rim with a banded shoulder", speed: 1.04, accel: 1.06, cornering: 1.06, braking: 1.05, visual: { deflector: 1, spokes: 0, tape: 0, dish: 1, nut: [0.95, 0.05, 0.04], gunNut: 1 }, visualTier: 2 },
      { id: "sig_mclaren_rim", label: "Woking Rim", cost: 170, teams: ["mclaren"], tag: "SIGNATURE", equivalent: "works_rim",
        desc: "McLaren signature rim — Works Rim performance with a 8-spoke rim with a banded shoulder", speed: 1.04, accel: 1.06, cornering: 1.06, braking: 1.05, visual: { deflector: 2, spokes: 8, tape: 1, dish: 1, nut: [1, 0.5, 0] , gunNut: 1}, visualTier: 2 },
      { id: "sig_redbull_rim", label: "Milton Keynes Rim", cost: 40, teams: ["redbull"], tag: "SIGNATURE", equivalent: "spoked",
        desc: "Red Bull signature rim — Spoked Rim performance with a 5-spoke rim with a banded shoulder", speed: 0.99, accel: 1.02, braking: 1.05, visual: { deflector: 1, spokes: 5, tape: 1, dish: 2, nut: [0.95, 0.78, 0] , gunNut: 1}, visualTier: 1 },
      { id: "sig_alpine_rim", label: "Enstone Rim", cost: 50, teams: ["alpine"], tag: "SIGNATURE", equivalent: "taped",
        desc: "Alpine signature rim — Taped Rim performance with a 4-spoke rim with a banded shoulder", speed: 1.01, cornering: 1.05, braking: 0.99, visual: { deflector: 0, spokes: 4, tape: 1, dish: 1, nut: [1, 0.53, 0.74] , gunNut: 1}, visualTier: 1 },
      { id: "sig_racingbulls_rim", label: "Faenza Rim", cost: 60, teams: ["racingbulls"], tag: "SIGNATURE", equivalent: "dished",
        desc: "Racing Bulls signature rim — Dished Cover performance with a 6-spoke rim", speed: 1.04, cornering: 1.01, braking: 0.98, visual: { deflector: 1, spokes: 6, tape: 0, dish: 0, nut: [0.2, 0.3, 0.95] , gunNut: 1}, visualTier: 1 },
      { id: "sig_haas_rim", label: "Kannapolis Rim", cost: 0, teams: ["haas"], tag: "SIGNATURE", equivalent: "standard",
        desc: "Haas signature rim — Standard performance with a 8-spoke rim", visual: { deflector: 0, spokes: 8, tape: 0, dish: 0, nut: [0.88, 0.88, 0.9] }, visualTier: 1 },
      { id: "sig_williams_rim", label: "Grove Rim", cost: 130, teams: ["williams"], tag: "SIGNATURE", equivalent: "aero_disc",
        desc: "Williams signature rim — Aero Disc performance with a plain rim", speed: 1.07, cornering: 1.02, braking: 0.95, visual: { deflector: 2, spokes: 0, tape: 0, dish: 1, nut: [0.2, 0.55, 0.95] }, visualTier: 2 },
      { id: "sig_audi_rim", label: "Neuburg Rim", cost: 110, teams: ["audi"], tag: "SIGNATURE", equivalent: "mag_forged",
        desc: "Audi signature rim — Forged Mag performance with a 7-spoke rim with a banded shoulder", accel: 1.07, cornering: 1.03, braking: 1.06, visual: { deflector: 1, spokes: 7, tape: 1, dish: 2, nut: [0.98, 0.28, 0.05] }, visualTier: 2 },
      { id: "sig_astonmartin_rim", label: "Silverstone Rim", cost: 60, teams: ["astonmartin"], tag: "SIGNATURE", equivalent: "dished",
        desc: "Aston Martin signature rim — Dished Cover performance with a 6-spoke rim with a banded shoulder", speed: 1.04, cornering: 1.01, braking: 0.98, visual: { deflector: 0, spokes: 6, tape: 1, dish: 1, nut: [0.72, 0.88, 0.11] }, visualTier: 1 },
      { id: "sig_cadillac_rim", label: "Detroit Rim", cost: 130, teams: ["cadillac"], tag: "SIGNATURE", equivalent: "aero_disc",
        desc: "Cadillac signature rim — Aero Disc performance with a 4-spoke rim with a banded shoulder", speed: 1.07, cornering: 1.02, braking: 0.95, visual: { deflector: 2, spokes: 4, tape: 1, dish: 2, nut: [0.85, 0.7, 0.32] }, visualTier: 2 },
    ],
  },
];

const DEFAULTS: PartSetupFull = {
  engine: "stock", aero: "medium", suspension: "standard",
  brakes: "standard", tyres: "medium", ers: "standard",
  gearbox: "standard", fuel: "standard",
  exhaust: "stock", floor: "standard", cockpit: "standard", wheels: "standard",
};

// Every option.visual field has one declared consumer. Keep this registry
// beside the catalog so new recipe keys cannot silently become dead data.
const VISUAL_FIELD_REGISTRY = Object.freeze({
  geometry: Object.freeze({
    engine: Object.freeze(["in", "snork", "twin", "inlet", "outlet",
      "podWidth", "shoulderHeight", "undercut", "coke", "tailWidth", "coverHeight",
      "servicePanel", "heatShield", "chimney", "scoopLip"]),
    aero: Object.freeze(["lvl", "beam", "drs", "vane", "plate", "casc", "swan", "tvane",
      "arch", "gill", "duct", "board", "slot",
      "frontSweep", "frontTaper", "frontRise", "rearSweep", "rearTaper",
      "floorEdge", "floorCut", "diffuserRise", "fin"]),
    suspension: Object.freeze(["ride", "arm", "push", "pull", "wishbone", "toe", "rocker", "heave"]),
    brakes: Object.freeze(["duct", "caliperPos", "coverOpen", "rotor", "rotorScale", "scoop", "discFace", "caliper"]),
    // cover + coverVanes: opt-in covered face only (open rim is the default).
    // spokes / dish / gunNut: open-rim identity consumed by car-wheels when the
    // wheel part leaves them unset (wheel recipe still wins when set).
    tyres: Object.freeze(["grooves", "grooveDepth", "bandWidth", "coverVanes", "cover",
      "shoulder", "sidewall", "spokes", "dish", "gunNut"]),
    ers: Object.freeze(["pack", "cells", "conduit", "blister", "coolerIntake"]),
    gearbox: Object.freeze(["strakes", "fin", "strakeH", "finSY", "finSZ",
      "casing", "louvres", "heat", "caseWidth", "heatFins", "ribs"]),
    fuel: Object.freeze(["filler", "hatch", "vent", "breather"]),
    exhaust: Object.freeze(["pipes", "bore", "flare", "wastegate", "wrap",
      "lip", "shield"]),
    floor: Object.freeze(["fences", "fenceH", "skid", "edgeLip", "plank", "gurney", "scroll"]),
    cockpit: Object.freeze(["haloBlade", "haloWing", "camPods", "screen", "halo", "headrest", "mirror"]),
    wheels: Object.freeze(["spokes", "tape", "dish", "gunNut", "deflector"]),
  }),
  material: Object.freeze({
    wheels: Object.freeze(["nut"]),
    brakes: Object.freeze(["cal", "rim"]),
    tyres: Object.freeze(["band", "nut"]),
    ers: Object.freeze(["led"]),
    fuel: Object.freeze(["cap", "flame", "line"]),
  }),
  runtime: Object.freeze({
    fuel: Object.freeze(["fxFlame"]),
  }),
});

// Fixed visual identity for the 2026 grid: never read from player saves,
// never alters AI physics. Every SIGNATURE part clones the universal option
// the team already ran (same cost and stats), so this shapes meshes, not the
// pecking order. Teams on a manufacturer-exclusive FACTORY unit keep it —
// except Ferrari-powered Cadillac, which would otherwise render Ferrari's.
const FACTORY_PRESETS: Record<string, PartSetupFull> = {
  mercedes:    { engine: "sig_mercedes_zero", aero: "sig_mercedes_wing", suspension: "sig_mercedes_susp", brakes: "sig_mercedes_discs", tyres: "sig_mercedes_tyre", ers: "sig_mercedes_ers", gearbox: "sig_mercedes_gbox", fuel: "sig_mercedes_fuel", exhaust: "sig_mercedes_exh", floor: "sig_mercedes_floor", cockpit: "sig_mercedes_cpit", wheels: "sig_mercedes_rim" },
  ferrari:     { engine: "manu_ferrari", aero: "sig_ferrari_wing", suspension: "sig_ferrari_susp", brakes: "sig_ferrari_brembo", tyres: "sig_ferrari_tyre", ers: "sig_ferrari_ers", gearbox: "sig_ferrari_seamless", fuel: "sig_ferrari_fuel", exhaust: "sig_ferrari_exh", floor: "sig_ferrari_floor", cockpit: "sig_ferrari_cpit", wheels: "sig_ferrari_rim" },
  mclaren:     { engine: "sig_mclaren_pu", aero: "sig_mclaren_flex", suspension: "sig_mclaren_active", brakes: "sig_mclaren_brakes", tyres: "sig_mclaren_tyre", ers: "sig_mclaren_ers", gearbox: "sig_mclaren_gbox", fuel: "sig_mclaren_fuel", exhaust: "sig_mclaren_exh", floor: "sig_mclaren_floor", cockpit: "sig_mclaren_cpit", wheels: "sig_mclaren_rim" },
  redbull:     { engine: "manu_ford", aero: "sig_redbull_concept", suspension: "sig_redbull_pullrod", brakes: "sig_redbull_brakes", tyres: "sig_redbull_tyre", ers: "sig_redbull_ers", gearbox: "sig_redbull_gbox", fuel: "sig_redbull_fuel", exhaust: "sig_redbull_exh", floor: "sig_redbull_floor", cockpit: "sig_redbull_cpit", wheels: "sig_redbull_rim" },
  alpine:      { engine: "sig_alpine_pu", aero: "sig_alpine_wing", suspension: "sig_alpine_susp", brakes: "sig_alpine_brakes", tyres: "sig_alpine_tyre", ers: "sig_alpine_boost", gearbox: "sig_alpine_gbox", fuel: "sig_alpine_efuel", exhaust: "sig_alpine_exh", floor: "sig_alpine_floor", cockpit: "sig_alpine_cpit", wheels: "sig_alpine_rim" },
  racingbulls: { engine: "sig_racingbulls_pu", aero: "sig_racingbulls_wing", suspension: "sig_racingbulls_susp", brakes: "sig_racingbulls_brakes", tyres: "sig_rb_street", ers: "sig_racingbulls_ers", gearbox: "sig_rb_shortcase", fuel: "sig_racingbulls_fuel", exhaust: "sig_racingbulls_exh", floor: "sig_racingbulls_floor", cockpit: "sig_racingbulls_cpit", wheels: "sig_racingbulls_rim" },
  haas:        { engine: "sig_haas_pu", aero: "sig_haas_wing", suspension: "sig_haas_susp", brakes: "sig_haas_carbonmag", tyres: "sig_haas_tyre", ers: "sig_haas_ers", gearbox: "sig_haas_gbox", fuel: "sig_haas_blend", exhaust: "sig_haas_exh", floor: "sig_haas_floor", cockpit: "sig_haas_cpit", wheels: "sig_haas_rim" },
  williams:    { engine: "sig_williams_pu", aero: "sig_williams_lowdrag", suspension: "sig_williams_susp", brakes: "sig_williams_brakes", tyres: "sig_williams_tyre", ers: "sig_williams_ers", gearbox: "sig_williams_longshift", fuel: "sig_williams_fuel", exhaust: "sig_williams_exh", floor: "sig_williams_floor", cockpit: "sig_williams_cpit", wheels: "sig_williams_rim" },
  audi:        { engine: "manu_audi", aero: "sig_audi_wing", suspension: "sig_audi_damper", brakes: "sig_audi_brakes", tyres: "sig_audi_tyre", ers: "sig_audi_quattro", gearbox: "sig_audi_gbox", fuel: "sig_audi_fuel", exhaust: "sig_audi_exh", floor: "sig_audi_floor", cockpit: "sig_audi_cpit", wheels: "sig_audi_rim" },
  astonmartin: { engine: "manu_honda", aero: "sig_aston_tunnel", suspension: "sig_astonmartin_susp", brakes: "sig_aston_carbon", tyres: "sig_astonmartin_tyre", ers: "sig_astonmartin_ers", gearbox: "sig_astonmartin_gbox", fuel: "sig_astonmartin_fuel", exhaust: "sig_astonmartin_exh", floor: "sig_astonmartin_floor", cockpit: "sig_astonmartin_cpit", wheels: "sig_astonmartin_rim" },
  cadillac:    { engine: "sig_cadillac_pu", aero: "sig_cadillac_lowline", suspension: "sig_cadillac_susp", brakes: "sig_cadillac_brakes", tyres: "sig_cadillac_sprint", ers: "sig_cadillac_ers", gearbox: "sig_cadillac_gbox", fuel: "sig_cadillac_fuel", exhaust: "sig_cadillac_exh", floor: "sig_cadillac_floor", cockpit: "sig_cadillac_cpit", wheels: "sig_cadillac_rim" },
};

function teamContext(team: PartsTeam): { id: string | null; engine: string | null } {
  if (typeof team === "string") return { id: null, engine: team };
  return {
    id: team && team.id || null,
    engine: team && team.engine || null,
  };
}

// THE REGULATION HOOK. A career era makes some options illegal for a few
// seasons (js/career/regulations.js). It is installed at runtime rather than
// imported because parts.js loads BEFORE js/career/ — and because that keeps
// the rule where it belongs: a Grand Prix or a standalone Season never sets
// one, so only a career is ever regulated.
//
// It is deliberately wired HERE and nowhere else. _resolve() consults this
// function for every category of every resolution and falls back to DEFAULTS,
// and resolveSetup() is the one path BOTH the player's career build and every
// AI factory build go through — so one predicate reaches the whole grid at
// once. A rule that only reached the player would be a tax, not a regulation.
let _legal: LegalityFn | null = null;      // (opt) => boolean, or null for "everything is legal"
let _legalKey = "";     // identifies the ruleset, for the factory cache key
function setLegality(fn: unknown, key?: unknown): void {
  _legal = typeof fn === "function" ? fn as LegalityFn : null;
  _legalKey = _legal ? String(key || "on") : "";
}
function legalityKey(): string { return _legalKey; }
// The installed predicate itself, so a caller that must read the WORKS build
// outside the era (CareerAiDev.worksSetup) can put the exact ruleset back.
function legality(): LegalityFn | null { return _legal; }
function isOptionAvailable(opt: PartOption, team: PartsTeam, owned?: OwnedSet | null): boolean {
  const ctx = teamContext(team);
  const suppliers = opt.suppliers || (opt.supplier ? [opt.supplier] : null);
  const teams = opt.teams || (opt.team ? [opt.team] : null);
  if (suppliers && !suppliers.includes(ctx.engine as string)) return false;
  if (teams && !teams.includes(ctx.id as string)) return false;
  if (owned && !owned.has(opt.id)) return false;
  if (_legal && !_legal(opt)) return false;
  return true;
}

// When the save asks for an option this team cannot fit (SIGNATURE teams
// list, manufacturer suppliers, or a career regulation), prefer that
// option's `equivalent` over the category DEFAULT. DEFAULTS.tyres is
// `medium`; a locked `sig_rb_street` must still draw `supersoft` (its peer),
// not the yellow medium ring. Mesh, band, stats and label all come from the
// resolved option — one path, so the garage name matches what is on the car.
// (sig_mercedes_tyre's peer is medium, same as DEFAULTS; the visible proof
// of the path is any signature whose equivalent is not the default.)
function _resolve(cat: PartCategory, setup: PartSetup, team: PartsTeam): PartOption {
  const selId = setup[cat.id] !== undefined ? setup[cat.id] : DEFAULTS[cat.id];
  let opt = cat.options.find((o) => o.id === selId);
  if (opt && !isOptionAvailable(opt, team)) {
    const want = opt.equivalent;
    const eq = want
      ? cat.options.find((o) => o.id === want)
      : null;
    opt = (eq && isOptionAvailable(eq, team)) ? eq : undefined;
  }
  // cat.options[0] exists for every category; f1-game returns it unchecked.
  return opt || cat.options.find((o) => o.id === DEFAULTS[cat.id]) || cat.options[0]!;
}

const STAT_ORDER: readonly StatKey[] = ["speed", "accel", "cornering", "braking"];

// `tune` (optional) is the SETUP SHEET's four-channel contribution
// (SetupTune.mods) — multiplied in after the parts. factoryResolved never
// passes one, which is what keeps the AI field the works car.
function resolveSetup(setup?: PartSetup | null, team?: PartsTeam, tune?: PartsTune | null): ResolvedSetup {
  const requested: PartSetup = Object.assign({}, DEFAULTS, setup || {});
  // Filled for every CATALOG category by the loop below.
  const resolvedSetup = {} as PartSetupFull;
  const mods: StatMods = { speed: 1, accel: 1, cornering: 1, braking: 1 };
  const tiers = {} as Record<CategoryId, number>;
  const visual = {} as Record<CategoryId, ResolvedVisual>;
  const options = {} as Record<CategoryId, PartOption>;
  let cost = 0;
  for (const cat of CATALOG) {
    const opt = _resolve(cat, requested, team);
    const tier = opt.visualTier != null ? opt.visualTier : 1;
    resolvedSetup[cat.id] = opt.id;
    tiers[cat.id] = tier;
    options[cat.id] = opt;
    visual[cat.id] = Object.assign({ id: opt.id, tier }, opt.visual || {});
    cost += opt.cost || 0;
    if (opt.speed     !== undefined) mods.speed     *= opt.speed;
    if (opt.accel     !== undefined) mods.accel     *= opt.accel;
    if (opt.cornering !== undefined) mods.cornering *= opt.cornering;
    if (opt.braking   !== undefined) mods.braking   *= opt.braking;
  }
  if (tune) {
    for (const k of STAT_ORDER) { const v = tune[k]; if (Number.isFinite(v)) mods[k] *= v as number; }
  }
  return { setup: resolvedSetup, mods, cost, ids: resolvedSetup, tiers, visual, options };
}

// The fitted compound's wet TREAD CLASS: 0 slick, 1 intermediate, 2 full wet.
// The one thing outside the four stat multipliers that a tyre tells the
// physics — game.js indexes WET_GRIP with it. Absent means slick.
function tread(setup?: PartSetup | null, team?: PartsTeam): number {
  return resolveSetup(setup, team).options.tyres.wetTread || 0;
}

const factoryCache = new Map<string, ResolvedSetup>();
// A team carrying its OWN factory object is cached per that object (every
// legend is id "legends"; custom-team swaps the team on a legend switch), so
// the string key below never serves one legend another's build.
const factoryCacheOwn = new WeakMap<object, Map<string, ResolvedSetup>>();
function factoryResolved(team: PartsTeam): ResolvedSetup {
  // A string team has no id / engine / factory member (f1-game reads undefined).
  const obj = typeof team === "string" ? null : team;
  const id = obj && obj.id || "";
  // THE RULESET IS PART OF THE KEY. Without it an era would be a no-op on the
  // AI side — every factory build would be served from a cache filled before
  // the rules changed, and the player would be the only car obeying them.
  const key = `${id}|${obj && obj.engine || ""}|${_legalKey}`;
  const own = obj && obj.factory;
  let cache = factoryCache;
  if (own && typeof own === "object") {
    let c = factoryCacheOwn.get(own);
    if (!c) { c = new Map(); factoryCacheOwn.set(own, c); }
    cache = c;
  }
  let resolved = cache.get(key);
  if (!resolved) {
    // A TEAM MAY CARRY ITS OWN FACTORY SETUP. FACTORY_PRESETS is keyed by a
    // team id this file knows, so a team minted at runtime — a legend duel
    // rival (js/data/legends.js raceTeam) — silently took DEFAULTS and raced a
    // modern chassis. `team.factory` lets the team state its own build; the
    // preset table stays the answer for everyone who does not.
    resolved = resolveSetup((obj && obj.factory) || FACTORY_PRESETS[id] || DEFAULTS, team);
    cache.set(key, resolved);
  }
  return resolved;
}

function getFactorySetup(team: PartsTeam): PartSetupFull {
  return factoryResolved(team).setup;
}

function factoryKey(team: PartsTeam): string {
  const resolved = factoryResolved(team);
  return CATALOG.map((cat) => resolved.ids[cat.id]).join("|");
}

function getMods(setup?: PartSetup | null, team?: PartsTeam, tune?: PartsTune | null): StatMods {
  return resolveSetup(setup, team, tune).mods;
}

function getCost(setup?: PartSetup | null, team?: PartsTeam): number {
  return resolveSetup(setup, team).cost;
}

function statMult(stat: number): number {
  return 0.85 + (stat / 100) * 0.15;
}

// The four headline stats and the curve that turns a raw (base * mods) figure
// into the number a player is shown. It lives HERE rather than in the garage
// panel because it now has two readers — the DOM panel and the in-world stats
// board on the bay wall — and two copies of a display curve is exactly how
// the same car ends up quoting two different numbers.
const STAT_KEYS: readonly { readonly key: StatKey; readonly label: string }[] = Object.freeze([
  Object.freeze({ key: "speed", label: "SPEED" } as const),
  Object.freeze({ key: "accel", label: "ACCEL" } as const),
  Object.freeze({ key: "cornering", label: "CORNERING" } as const),
  Object.freeze({ key: "braking", label: "BRAKING" } as const),
]);
const STAT_KNEE = 100;
const STAT_CAP = 120;
const STAT_KNEE_SCALE = 26;
function displayStat(raw: number): number {
  if (raw <= STAT_KNEE) return raw;
  return STAT_KNEE + (STAT_CAP - STAT_KNEE) * (1 - Math.exp(-(raw - STAT_KNEE) / STAT_KNEE_SCALE));
}

// The { lo, hi } range one stat multiplier spans across a category's options
// (an absent multiplier is 1), and where a value sits in it, 0..1.
function statSpan(catId: CategoryId, key: StatKey): StatSpan {
  // Only called with catalog ids; f1-game would throw on a missing one too.
  const cat = CATALOG.find((c) => c.id === catId)!;
  let lo = Infinity, hi = -Infinity;
  for (const o of cat.options) {
    const v = o[key] !== undefined ? o[key] : 1;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return { lo, hi };
}
function spanFraction(v: number, span: StatSpan): number {
  return span.hi > span.lo ? Math.max(0, Math.min(1, (v - span.lo) / (span.hi - span.lo))) : 0.5;
}
const AERO_SPAN = statSpan("aero", "cornering");
const ERS_SPAN = { deploy: statSpan("ers", "accel"), regen: statSpan("ers", "speed") };
function ersProfile(setup?: PartSetup | null, team?: PartsTeam): { deploy: number; regen: number } {
  const opt = resolveSetup(setup, team).options.ers;
  const at = (k: StatKey, span: StatSpan) => spanFraction(opt && opt[k] !== undefined ? opt[k] : 1, span);
  return { deploy: at("accel", ERS_SPAN.deploy), regen: at("speed", ERS_SPAN.regen) };
}

// `tune.rake` (optional, −1..1 from SetupTune.aero) adds RH_GAIN of load on
// top of the wing's normalised load, clamped — so an untouched car reads
// exactly what it always did, and the measured aero table stays true.
const RH_GAIN = 0.06;
function aeroLoad(setup?: PartSetup | null, team?: PartsTeam, tune?: PartsTune | null): number {
  const opt = resolveSetup(setup, team).options.aero;
  const w = opt && opt.cornering !== undefined ? opt.cornering : 1;
  const base = spanFraction(w, AERO_SPAN);
  const rake = tune && Number.isFinite(tune.rake) ? Math.max(-1, Math.min(1, tune.rake as number)) : 0;
  return rake ? Math.max(0, Math.min(1, base + RH_GAIN * rake)) : base;
}

// { engine: 0|1|2, aero: 0|1|2, ... } — the resolved cosmetic tier per
// category for Car3D.build(opts.parts). Shares resolveSetup's lock
// fallback (equivalent, then DEFAULTS), so a locked-out option never
// keeps a foreign visual tier; an untagged option falls back to tier 1.
function getVisualTiers(setup?: PartSetup | null, team?: PartsTeam): VisualTiers {
  const resolved = resolveSetup(setup, team);
  const out = Object.assign({}, resolved.tiers) as VisualTiers;
  out._ids = resolved.ids;
  out._visual = resolved.visual;
  return out;
}

export {
  CATALOG, DEFAULTS, FACTORY_PRESETS, VISUAL_FIELD_REGISTRY, BUDGET,
  resolveSetup, isOptionAvailable,
  getFactorySetup, factoryKey,
  getMods, getCost, getVisualTiers, statMult, displayStat, STAT_KEYS, aeroLoad, ersProfile, tread, RH_GAIN,
  setLegality, legalityKey, legality,
};

/** f1-game's `Parts` global (parts.js:855-863), same members, frozen shallowly. */
export const Parts = Object.freeze({
  CATALOG, DEFAULTS, FACTORY_PRESETS, VISUAL_FIELD_REGISTRY, BUDGET,
  resolveSetup, isOptionAvailable,
  getFactorySetup, factoryKey,
  getMods, getCost, getVisualTiers, statMult, displayStat, STAT_KEYS, aeroLoad, ersProfile, tread, RH_GAIN,
  setLegality, legalityKey, legality,
});
export type PartsApi = typeof Parts;
