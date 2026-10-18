/**
 * Engine tone model: constant manufacturer timbre, player tune presets and
 * their ranges. No audio nodes, no context state.
 *
 * Ported verbatim from f1-game js/audio/tone-model.js:4-136 (GameAudioToneModel).
 * Every field is CONSTANT TIMBRE — a fixed multiplier or filter, never a
 * function of rev — so pitch stays monotonic in rev for every voice.
 */

/** Per-manufacturer character, keyed by team.engine. tone-model.js:13-20. */
export interface EngineVoice {
  readonly rateTrim: number;
  readonly detune: number;
  readonly formantHz: number;
  readonly formantGain: number;
  readonly cutTrim: number;
  readonly whineHz: number;
  readonly whineLvl: number;
  readonly synthSpread: number;
  readonly subLvl: number;
}

export const ENGINE_VOICES: Readonly<Record<string, EngineVoice>> = {
  "default":       { rateTrim: 1.00, detune: 0,   formantHz: 0,    formantGain: 0, cutTrim: 1.00, whineHz: 1500, whineLvl: 1.0, synthSpread: 1.009, subLvl: 1.0 },
  "Mercedes":      { rateTrim: 1.00, detune: 0,   formantHz: 1250, formantGain: 3, cutTrim: 1.05, whineHz: 1600, whineLvl: 0.9, synthSpread: 1.007, subLvl: 0.9 },
  "Ferrari":       { rateTrim: 1.03, detune: 25,  formantHz: 1900, formantGain: 5, cutTrim: 1.12, whineHz: 1500, whineLvl: 0.8, synthSpread: 1.013, subLvl: 0.8 },
  "Red Bull Ford": { rateTrim: 0.99, detune: -15, formantHz: 800,  formantGain: 4, cutTrim: 0.96, whineHz: 1350, whineLvl: 0.7, synthSpread: 1.018, subLvl: 1.2 },
  "Honda":         { rateTrim: 1.01, detune: 10,  formantHz: 1500, formantGain: 2, cutTrim: 1.04, whineHz: 1750, whineLvl: 1.1, synthSpread: 1.005, subLvl: 0.95 },
  "Audi":          { rateTrim: 0.98, detune: -20, formantHz: 950,  formantGain: 3, cutTrim: 0.92, whineHz: 2100, whineLvl: 1.5, synthSpread: 1.010, subLvl: 1.1 },
};

/** The default voice; always present. */
export const DEFAULT_VOICE: EngineVoice = ENGINE_VOICES["default"] as EngineVoice;

/**
 * The player tune: a second trim over the manufacturer voice. The pitch curve
 * is four independent knobs, rate(rev) = (IDLE*idle + SPAN*revRange*rev^curve)
 * * pitch. tone-model.js:22-66.
 */
export interface Tune {
  pitch: number; idle: number; revRange: number; curve: number; detune: number;
  brightness: number; gravel: number; sub: number;
  limiter: number; limRate: number; limPitch: number; boost: number; boostPitch: number;
  whine: number; harvest: number; wind: number; screech: number; brakes: number;
  shift: number; rivals: number; reverb: number; overrun: number;
}
export type TuneKey = keyof Tune;

/** The shipped voice. tone-model.js:62-66. */
export const TUNE_DEF: Readonly<Tune> = Object.freeze({
  pitch: 0.85, idle: 1, revRange: 1.3, curve: 1, detune: 0, brightness: 1, gravel: 1, sub: 0.25,
  limiter: 2.25, limRate: 0.8, limPitch: 0, boost: 1.12, boostPitch: 1,
  whine: 0.62, harvest: 1, wind: 1, screech: 1, brakes: 1, shift: 1, rivals: 1, reverb: 1, overrun: 1,
});

/** Slider ranges; every range contains 1.0 exactly. tone-model.js:77-85. */
export const TUNE_RANGE: Readonly<Record<TuneKey, readonly [number, number]>> = Object.freeze({
  pitch:      [0.60, 1.80], idle:  [0.50, 1.60], revRange: [0.20, 4.00], curve: [0.40, 2.50],
  detune:     [0, 4],       brightness: [0.30, 2.50], gravel: [0, 4],    sub: [0, 4],
  limiter:    [0, 3],       limRate: [0.40, 3.00], limPitch: [0, 4],
  boost:      [0, 4],       boostPitch: [0, 4],
  whine:      [0, 4],       harvest: [0, 4],     wind:     [0, 4],    screech: [0, 4],
  brakes:     [0, 4],       shift: [0, 3],       rivals:   [0, 4],    reverb:  [0, 4],   overrun: [0, 4],
});

/** Layer switches; each names an existing node. tone-model.js:91. */
export interface Layers {
  whine: boolean; harvest: boolean; ers: boolean; wind: boolean; limiter: boolean; screech: boolean;
  sub: boolean; gravel: boolean; brakes: boolean; rivals: boolean; reverb: boolean; overrun: boolean;
}
export type LayerKey = keyof Layers;
export const LAYER_DEF: Readonly<Layers> = Object.freeze({ whine: true, harvest: true, ers: true, wind: true, limiter: true, screech: true, sub: true, gravel: true, brakes: true, rivals: true, reverb: true, overrun: true });

/** Named presets; "team" is identity. tone-model.js:99-109. */
export type SoundProfile = "team" | "broadcast" | "trackside" | "cockpit" | "v10";
export const SOUND_PROFILES: Readonly<Record<SoundProfile, Readonly<Partial<Tune>> | null>> = Object.freeze({
  team:      null,
  broadcast: { pitch: 1.02, detune: 0.9, revRange: 1.05, brightness: 1.18, whine: 1.30, sub: 0.80, limiter: 1.00, gravel: 0.60, brakes: 0.90, shift: 1.10, boost: 1.20, rivals: 1.20, wind: 0.80 },
  trackside: { pitch: 0.99, detune: 1.3, revRange: 1.00, brightness: 0.82, whine: 0.65, sub: 1.15, limiter: 0.85, idle: 0.95, gravel: 1.40, brakes: 1.20, shift: 0.90, wind: 1.40, screech: 1.30, rivals: 1.50, limPitch: 0.70 },
  cockpit:   { pitch: 1.00, detune: 1.0, revRange: 0.92, brightness: 0.68, whine: 0.85, sub: 1.60, limiter: 1.35, curve: 0.95, gravel: 1.30, brakes: 1.50, shift: 1.40, limPitch: 1.30, harvest: 1.20, wind: 0.70, boost: 1.10 },
  v10:       { pitch: 1.07, detune: 2.2, revRange: 1.60, brightness: 1.28, whine: 0.10, sub: 0.70, limiter: 1.15, idle: 0.85, curve: 1.25, gravel: 0.30, brakes: 0.80, shift: 1.20, limRate: 1.30, limPitch: 1.50, boost: 0.15, boostPitch: 0.50, harvest: 0.20 },
});

const TUNE_KEYS = Object.keys(TUNE_DEF) as TuneKey[];
const PROFILE_KEYS = Object.keys(SOUND_PROFILES) as SoundProfile[];

export function isProfile(name: unknown): name is SoundProfile {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(SOUND_PROFILES, name);
}

/** Clamp each recognised finite field of `patch` into TUNE_RANGE. tone-model.js:111-118. */
export function patchTune(tune: Tune, patch: Readonly<Record<string, unknown>> | null | undefined): void {
  if (patch) for (const k of TUNE_KEYS) {
    const v = patch[k];
    if (typeof v !== "number" || !isFinite(v)) continue;
    const [lo, hi] = TUNE_RANGE[k];
    tune[k] = Math.max(lo, Math.min(hi, v));
  }
}

/** The profile the live tune is, or "custom"; the current name wins ties. tone-model.js:124-132. */
export function nameForTune(tune: Readonly<Tune>, profileName: string): SoundProfile | "custom" {
  const fits = (name: string): name is SoundProfile => {
    if (!isProfile(name)) return false;
    const want: Tune = Object.assign({}, TUNE_DEF, SOUND_PROFILES[name] || {});
    return TUNE_KEYS.every((k) => Math.abs(tune[k] - want[k]) < 1e-9);
  };
  if (fits(profileName)) return profileName;
  return PROFILE_KEYS.find(fits) || "custom";
}
