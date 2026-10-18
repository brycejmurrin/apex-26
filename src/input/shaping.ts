/**
 * Pure steering and pedal shaping, ported from f1-game js/input/input.js.
 *
 * - `moveToward`       input.js:502-504
 * - `toShaped`/`fromShaped` input.js:1983-1988 (STEER_EXPO 2.3889, LINEARITY 5)
 * - `digitalStep`      input.js:529-541 (the key / d-pad ramp, in shaped space)
 * - `padAxisShape`     input.js:837-847 (dead zone, rest offset, saturation)
 * - `padPedalLevel`    input.js:873-874
 *
 * The digital ramp works in SHAPED (road-wheel) space and returns raw, so the
 * physics' `|steer|^STEER_EXPO` undoes it and a held key ramps linearly in
 * road-wheel angle (input.js:529-530). Adaptive buttons (input.js:543-548) is
 * off by default and not ported yet.
 */

/** input.js:1983 `steerExpo`, the shipped LINEARITY 5. */
export const STEER_EXPO = 2.3889;
/** input.js:18 `KEY_RAMP_IN`, road-wheel units/s toward full lock. */
export const KEY_RAMP_IN = 4;
/** input.js:19 `KEY_RAMP_OUT`, road-wheel units/s back to centre. */
export const KEY_RAMP_OUT = 8;
/** input.js:105 `PAD_DZ_DEFAULT`. */
export const PAD_DZ_DEFAULT = 0.05;
/** input.js:873 `PAD_PEDAL_DZ`. */
export const PAD_PEDAL_DZ = 0.12;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function moveToward(v: number, target: number, step: number): number {
  return v + clamp(target - v, -step, step);
}

export function toShaped(v: number, expo = STEER_EXPO): number {
  return (v < 0 ? -1 : 1) * Math.pow(Math.abs(v), expo);
}

export function fromShaped(v: number, expo = STEER_EXPO): number {
  return (v < 0 ? -1 : 1) * Math.pow(Math.abs(v), 1 / expo);
}

/**
 * One ramp step of a digital steer source toward `target` (-1, 0 or +1) over
 * `dt` seconds. Reversing through centre unwinds at the out-rate and spends the
 * leftover time ramping in (input.js:533-539).
 */
export function digitalStep(val: number, target: number, dt: number, rateIn = KEY_RAMP_IN, expo = STEER_EXPO): number {
  const v = toShaped(val, expo), t = target;
  if (t === 0) return fromShaped(moveToward(v, 0, KEY_RAMP_OUT * dt), expo);
  if (v * t < 0) {
    const toCentre = Math.abs(v);
    const unwind = KEY_RAMP_OUT * dt;
    if (unwind < toCentre) return fromShaped(moveToward(v, 0, unwind), expo);
    const spare = (unwind - toCentre) / KEY_RAMP_OUT;
    return fromShaped(moveToward(0, t, rateIn * spare), expo);
  }
  return fromShaped(moveToward(v, t, rateIn * dt), expo);
}

/**
 * Stick deflection to a -1..1 steer: subtract the pad's rest offset, ignore
 * the inner dead zone, re-scale the remaining travel up to `1 - saturation`.
 */
export function padAxisShape(raw: number, rest = 0, deadzone = PAD_DZ_DEFAULT, saturation = 0): number {
  const d = raw - rest;
  const v = clamp(d >= 0 ? d / (1 - rest) : d / (1 + rest), -1, 1);
  const a = Math.abs(v);
  if (a <= deadzone) return 0;
  const span = Math.max(0.05, 1 - deadzone - saturation);
  return clamp(Math.sign(v) * (a - deadzone) / span, -1, 1);
}

/** Trigger travel 0..1 past the pedal dead zone. */
export function padPedalLevel(v: number): number {
  return v > PAD_PEDAL_DZ ? clamp((v - PAD_PEDAL_DZ) / (1 - PAD_PEDAL_DZ), 0, 1) : 0;
}
