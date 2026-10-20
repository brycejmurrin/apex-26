// What the fx modules read from the rest of the game, injected instead of read off
// globals. f1-game's js/fx/*.js reach for four globals, each `typeof`-guarded:
//   - `Math.random`           (particles.js:101, droplets.js:123: visual only, never the sim)
//   - `LightTune.LT`          (particles.js:87-91 particleMul, :443-445 the rain knobs)
//   - `PerfGov.autoShed()`    (particles.js:96-99, the frame governor's shed level)
//   - `Log.info`              (init/create breadcrumbs; dropped here, nothing reads them)
// An absent global took the guarded default; `DEFAULT_FX_ENV` is exactly those defaults,
// so a headless test runs the same branches f1-game's VM tests do with no globals.

/** The `LightTune.LT` knobs the fx modules read (f1-game js/lighting/light-tune.js). All
 *  optional: f1-game tests each with `!= null` / `!== undefined` and falls back per knob.
 *  TODO(lane-render): the lighting tuner owns LT; the shell passes its live object here. */
export interface FxTune {
  readonly particleMul?: number;
  readonly rainCount?: number;
  readonly rainSpeed?: number;
  readonly rainStreak?: number;
  readonly rainWind?: number;
  readonly rainOpacity?: number;
  readonly rainShearWind?: number;
  readonly rainShearLen?: number;
  readonly windDir?: number;
  readonly drizzleCount?: number;
  readonly drizzleLen?: number;
  readonly drizzleSpeed?: number;
}

export interface FxEnv {
  /** [0, 1). f1-game's `Math.random`; tests pass a seeded stream. */
  readonly random: () => number;
  /** `LightTune.LT`, or null where no tuner exists (particles.js `_lt()` returns `{}`). */
  readonly tune: () => FxTune | null;
  /** `PerfGov.autoShed() | 0`; 0 where no governor exists.
   *  TODO(lane-shell): wire the frame governor's measured shed level. */
  readonly autoShed: () => number;
}

export const DEFAULT_FX_ENV: FxEnv = Object.freeze({
  random: () => Math.random(),
  tune: () => null,
  autoShed: () => 0,
});
