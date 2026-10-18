/** Shared Data Hub driver colors and lane identity counts. Ported from f1-game js/data/tab-utils.js:1-27. */
import type { Rgb } from "./teams";

export interface ColoredDriver { color?: string | null; team?: string | null }

// Callers choose their existing missing-team fallback (LIVE: null;
// TELEMETRY: gray). OpenF1's unprefixed six-digit color takes precedence.
export function driverColor<F>(d: ColoredDriver | null | undefined, findTeam: (team: string | null | undefined) => { color: Rgb } | null | undefined, fallback: F): Rgb | F {
  if (d && d.color && /^[0-9a-fA-F]{6}$/.test(d.color)) {
    return [parseInt(d.color.slice(0, 2), 16) / 255,
            parseInt(d.color.slice(2, 4), 16) / 255,
            parseInt(d.color.slice(4, 6), 16) / 255];
  }
  const team = findTeam(d && d.team);
  return team ? team.color : fallback;
}

export function countsByDriver(entries: readonly { d: { num: number | string | null } }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  entries.forEach((entry) => {
    const k = String(entry.d.num);
    counts[k] = (counts[k] || 0) + 1;
  });
  return counts;
}
