/**
 * The SETUP SHEET: the car's mechanical set-up — anti-roll bars, ride height /
 * rake, brake bias — per team, persisted, folded into the parts contract
 * (Parts.getMods / aeroLoad take an optional tune) and the friction ellipse
 * (brake bias).
 *
 * Port of f1-game js/garage/setup-tune.js:1-153, verbatim. `axleGrip`,
 * `bbScales` and `BB_REF` (setup-tune.js:34, :100-114, :145-149) were already
 * ported by the physics lane in ../physics/setup-axle.ts and are re-exported
 * from there, not duplicated.
 *
 * f1-game's SetupTune is a global reading the global GameStore.store; here the
 * store is injected: `createSetupTune(store)` builds the API over one store, and
 * `SetupTune` is the instance over the page's localStorage (./store.ts).
 *
 * Also exported: `playerSetup`, the bridge f1-game's game.js applies to the
 * player car (js/game.js:1402-1419 recomputePlayerMods, :1545-1550 makeCars).
 */
import { BB_REF, axleGrip, bbScales } from "../physics/setup-axle";
import { createGarageStore, type GarageStoreLike } from "./store";

export { BB_REF, axleGrip, bbScales };
export type { AxleGrip } from "../physics/setup-axle";

export type TuneField = "arbF" | "arbR" | "rideF" | "rideR" | "brakeBias";
/** A full, normalised setup sheet. */
export type Tune = Record<TuneField, number>;
/** A sheet patch as callers hand it in: a slider hands back strings, a damaged save anything. */
export type TunePatch = { [K in TuneField]?: unknown };

export interface TuneRange {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly label: string;
  readonly unit: string;
}

/** The four-channel contract (Parts.getMods' tune; car lane's PartsTune minus rake). */
export interface SetupMods {
  speed: number;
  accel: number;
  cornering: number;
  braking: number;
}

/** Parts.aeroLoad's tune (car lane's PartsTune.rake). */
export interface SetupAero {
  rake: number;
}

const KEY = "setup."; // + teamId; the store adds the a26. prefix

// RANGES. Anti-roll bars are 1–11 steps (the racing-game convention — real
// teams run discrete bar sets in N·m/deg that are confidential). Ride
// heights are static millimetres for the 2022+ ground-effect cars: front
// ~15–35 mm, rear ~40–80 mm, rake (rear − front) ~25–45 mm — approximate;
// the plank is 10 mm with 1 mm of wear allowed (FIA TR). Brake bias is the
// wheel's BB readout in % front: 50.0–62.0, real cars run ~52–60 and trim
// it ~0.5–1 % per corner.
export const RANGE: Readonly<Record<TuneField, TuneRange>> = {
  arbF: { min: 1, max: 11, step: 1, label: "FRONT ANTI-ROLL BAR", unit: "" },
  arbR: { min: 1, max: 11, step: 1, label: "REAR ANTI-ROLL BAR", unit: "" },
  rideF: { min: 15, max: 35, step: 1, label: "FRONT RIDE HEIGHT", unit: " mm" },
  rideR: { min: 40, max: 80, step: 1, label: "REAR RIDE HEIGHT", unit: " mm" },
  brakeBias: { min: 50, max: 62, step: 0.5, label: "BRAKE BIAS", unit: " % F" },
};
export const FIELDS = Object.keys(RANGE) as TuneField[];
// Works baselines. The untouched car is EXACTLY the car it always was: every
// multiplier below is 1 at the team's own default, whatever that default is.
export const BASE: Readonly<Tune> = { arbF: 6, arbR: 6, rideF: 25, rideR: 60, brakeBias: 56 };
export const DEFAULTS: Readonly<Record<string, Partial<Tune>>> = {
  redbull: { arbF: 8, arbR: 6, rideF: 22, rideR: 62 },
  mclaren: { arbF: 6, arbR: 7, rideF: 24, rideR: 58 },
  ferrari: { arbF: 7, arbR: 6, rideF: 23, rideR: 60 },
  mercedes: { arbF: 7, arbR: 7, rideF: 24, rideR: 60 },
  williams: { arbF: 5, arbR: 5, rideF: 26, rideR: 62 },
  haas: { arbF: 6, arbR: 5, rideF: 27, rideR: 64 },
};

export function defaults(teamId: string): Tune { return Object.assign({}, BASE, DEFAULTS[teamId] || {}); }

export function clampField(k: TuneField, v: unknown): number | null {
  const r = RANGE[k];
  // typeof, not Number(): a damaged field must fall back to the WORKS value,
  // and Number(null) / Number("") / Number(false) are all 0 — which would
  // silently clamp to the bottom of the range instead. A numeric STRING is
  // accepted because that is what an <input type=range> hands back.
  const n = typeof v === "number" ? v : (typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
  if (!Number.isFinite(n)) return null;
  const q = Math.round((n - r.min) / r.step) * r.step + r.min;
  return Math.min(r.max, Math.max(r.min, +q.toFixed(3)));
}

// One bounded experiment. Paired softening preserves the axle balance;
// a rear-only reduction would reduce the aggregate acceleration channel.
export function experiment(symptom: string, tune: Readonly<Tune>): Partial<Tune> | null {
  const changes: Partial<Tune> | null = symptom === "wide" ? { arbF: -1 }
    : symptom === "traction" ? { arbF: -1, arbR: -1 }
    : symptom === "entry" ? { brakeBias: 0.5 } : null;
  if (!changes) return null;
  const patch: Partial<Tune> = {};
  for (const k of Object.keys(changes) as TuneField[]) {
    const value = tune[k] + (changes[k] as number);
    if (!Number.isFinite(value) || value < RANGE[k].min || value > RANGE[k].max) return null;
    // Finite and in range, so clampField cannot answer null here.
    patch[k] = clampField(k, value) as number;
  }
  return patch;
}

export interface SetupTuneApi {
  readonly RANGE: typeof RANGE;
  readonly FIELDS: readonly TuneField[];
  readonly BASE: Readonly<Tune>;
  readonly DEFAULTS: typeof DEFAULTS;
  readonly BB_REF: number;
  defaults(teamId: string): Tune;
  get(teamId: string): Tune;
  set(teamId: string, patch: TunePatch | null | undefined): Tune;
  reset(teamId: string): Tune;
  isDefault(teamId: string): boolean;
  mods(teamId: string): SetupMods;
  rake(teamId: string): number;
  aero(teamId: string): SetupAero;
  brakeBias(teamId: string): number;
  bbScales: typeof bbScales;
  clampField: typeof clampField;
  balance(teamId: string): number;
  axleGrip: typeof axleGrip;
  experiment: typeof experiment;
}

/** SetupTune over `store` (setup-tune.js:4-152). */
export function createSetupTune(store: GarageStoreLike): SetupTuneApi {
  // The stored sheet, normalised on read (a damaged field falls to the default).
  function get(teamId: string): Tune {
    const d = defaults(teamId);
    const raw = store.get(KEY + teamId, null);
    const out = Object.assign({}, d);
    if (raw && typeof raw === "object") for (const k of FIELDS) {
      const v = clampField(k, (raw as Record<string, unknown>)[k]);
      if (v != null) out[k] = v;
    }
    return out;
  }
  function set(teamId: string, patch: TunePatch | null | undefined): Tune {
    const cur = get(teamId);
    for (const k of FIELDS) if (patch && patch[k] !== undefined) { const v = clampField(k, patch[k]); if (v != null) cur[k] = v; }
    store.set(KEY + teamId, cur);
    return cur;
  }
  // undefined REMOVES the key, so the store falls back to the shipped sheet
  // (setup.<team> in garage-defaults) exactly as a fresh install does; null
  // was a stored value that bypassed it.
  function reset(teamId: string): Tune { store.set(KEY + teamId, undefined); return get(teamId); }
  function isDefault(teamId: string): boolean {
    const d = defaults(teamId);
    const t = get(teamId);
    return FIELDS.every((k) => t[k] === d[k]);
  }

  // ANTI-ROLL BARS → the four-channel contract. Deltas are counted from the
  // team's own default so an untouched car is exactly 1.0. Stiffer overall
  // (total): sharper turn-in (cornering up) at the cost of traction (accel
  // down); stiffer FRONT than rear (split): more stable under braking, less
  // traction. The additional axleGrip channel below expresses
  // front/rear balance through lateral load transfer.
  function mods(teamId: string): SetupMods {
    const t = get(teamId), d = defaults(teamId);
    const total = ((t.arbF - d.arbF) + (t.arbR - d.arbR)) / 2;
    const split = (t.arbF - t.arbR) - (d.arbF - d.arbR);
    const cl = (v: number): number => Math.min(1.05, Math.max(0.95, v));
    return {
      speed: 1,
      accel: cl((1 - 0.003 * total) * (1 - 0.004 * split)),
      cornering: cl(1 + 0.006 * total),
      braking: cl(1 + 0.004 * split),
    };
  }
  // Front/rear roll-stiffness changes redistribute lateral load transfer.
  // Four contact-patch loads with sublinear tyre load sensitivity; normalise
  // against the same turn on the works setup so defaults remain identity.
  function balance(teamId: string): number {
    const t = get(teamId), d = defaults(teamId);
    return Math.max(-0.3, Math.min(0.3, ((t.arbF - t.arbR) - (d.arbF - d.arbR)) * 0.025));
  }
  // RIDE HEIGHT / RAKE → the aero-load channel: rake in [-1, 1] from the
  // team's default over the half-range. Parts.aeroLoad adds RH_GAIN·rake to
  // the normalised load and clamps — the untouched car and every AI car are
  // unchanged (their tune is absent), which keeps docs/PHYSICS.md's measured
  // aero table true. The cost: a max-wing car gains nothing from more rake
  // (already at 1), stated on the sheet.
  function rake(teamId: string): number {
    const t = get(teamId), d = defaults(teamId);
    const half = (RANGE.rideR.max - RANGE.rideR.min + RANGE.rideF.max - RANGE.rideF.min) / 2;
    return Math.max(-1, Math.min(1, ((t.rideR - t.rideF) - (d.rideR - d.rideF)) / half));
  }
  function aero(teamId: string): SetupAero { return { rake: rake(teamId) }; }

  // BRAKE BIAS → the friction ellipse's per-axle split (game.js muF/muR).
  function brakeBias(teamId: string): number { return get(teamId).brakeBias / 100; }

  return Object.freeze({ RANGE, FIELDS, BASE, DEFAULTS, BB_REF, defaults, get, set, reset, isDefault, mods, rake, aero, brakeBias, bbScales, clampField, balance, axleGrip, experiment });
}

/** The page's SetupTune, over localStorage under `a26.` (read lazily; safe in Node). */
export const SetupTune: SetupTuneApi = createSetupTune(createGarageStore());

/** What the player car takes from the sheet (game.js:1406-1419). */
export interface PlayerSetup {
  /** Front brake share 0..1 (`player.brakeBias`); BB_REF in a standard-class car. */
  brakeBias: number;
  /** Anti-roll-bar axle bias for axleGrip (`player.rollBalance`); 0 in a standard-class car. */
  rollBalance: number;
  /** The tune for Parts.getMods; undefined in a standard-class car. */
  mods: SetupMods | undefined;
  /** The tune for Parts.aeroLoad; undefined in a standard-class car. */
  aero: SetupAero | undefined;
}

/**
 * The bridge recomputePlayerMods (js/game.js:1402-1419) folds into the player
 * car: a "standard" class daily challenge runs the works car, so it takes no
 * sheet at all (brake bias at BB_REF, the ellipse split exactly 1/1). makeCars
 * (game.js:1545-1550) passes the same values for the player with standard
 * false; AI cars and the teammate never take the sheet.
 */
export function playerSetup(teamId: string, standard: boolean, tune: SetupTuneApi = SetupTune): PlayerSetup {
  return {
    brakeBias: standard ? BB_REF : tune.brakeBias(teamId),
    rollBalance: standard ? 0 : tune.balance(teamId),
    mods: standard ? undefined : tune.mods(teamId),
    aero: standard ? undefined : tune.aero(teamId),
  };
}
