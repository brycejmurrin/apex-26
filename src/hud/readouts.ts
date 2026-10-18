/**
 * Pure HUD readouts, ported from f1-game.
 *
 * - `fmtTime`   js/game.js:1035-1045, the HUD clock: two decimals, "-" when empty,
 *               rounded before splitting so 119.9996 never reads "1:60.00".
 * - `spdDigits` js/ui/hud-readouts.js:101-115: dash km/h to the shown integer,
 *               rounded, clamped 0..999, never -0.
 * - `dashKph`   js/game.js:370 `vStd(v) * 3.6`. The pace normaliser `vStd`
 *               arrives with the physics lane; until then the caller passes
 *               it (identity by default).
 *
 * DISPLAY ONLY: reads car state, never track curvature or the racing line.
 */

const KPH_PER_MPH = 1.609344;   // hud-readouts.js:91

export type SpeedUnits = "kmh" | "mph";

export function fmtTime(t: number): string {
  if (!Number.isFinite(t) || t <= 0) return "-";
  const cs = Math.round(t * 100), m = Math.floor(cs / 6000), s = (cs - m * 6000) / 100;
  return m + ":" + (s < 10 ? "0" : "") + s.toFixed(2);
}

export function dashKph(v: number, vStd: (v: number) => number = (x) => x): number {
  return vStd(v) * 3.6;
}

export function spdDigits(kph: number, units: SpeedUnits = "kmh"): number {
  let n = Math.round((Number.isFinite(kph) ? kph : 0) / (units === "mph" ? KPH_PER_MPH : 1));
  if (!Number.isFinite(n)) n = 0;
  return Math.max(0, Math.min(999, n));
}

/** "MPH" | "KPH" (hud-readouts.js:97-99). */
export function spdUnit(units: SpeedUnits = "kmh"): string {
  return units === "mph" ? "MPH" : "KPH";
}

/** Gear chip: "N" for 0, "R" for negative, else the number. */
export function gearText(gear: number): string {
  return gear < 0 ? "R" : gear === 0 ? "N" : String(gear);
}
