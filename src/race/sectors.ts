/**
 * SECTORS: which third of the lap a car is in, and the split timing for the
 * player and the field. Ported from f1-game js/game.js (main @ 2026-10-18):
 * `sectorAt` :1048-1055, the S3 remainder :6150, the field's sector bests
 * :6152-6163 and the player's splits :6166-6198, the line reset :6227-6228.
 */
import type { RaceCar, SectorTiming } from "../contracts/race";

/** Curated `def.sectors` splits when present; equal thirds otherwise (:1048-1055). */
export function sectorAt(s: number, total: number, sectors?: readonly number[] | null): number {
  let w = s % total; if (w < 0) w += total;   // wrapS, game.js:1046
  const frac = w / total;
  if (sectors && sectors.length === 2) {
    return frac < (sectors[0] as number) ? 0 : frac < (sectors[1] as number) ? 1 : 2;
  }
  return frac < 1 / 3 ? 0 : frac < 2 / 3 ? 1 : 2;
}

/** A fresh lapRec (game.js:2594-2599). */
export function freshTiming(sectorIdx = 0): SectorTiming {
  return {
    sectorIdx, sectorStartT: 0, sectorValid: true,
    sectorLast: [Infinity, Infinity, Infinity],
    sectorBests: [Infinity, Infinity, Infinity],
    fieldSectorBests: [Infinity, Infinity, Infinity],
  };
}

/** The time past the line inside this step, taken off S3 (game.js:6150). */
export function s3Past(dLine: number, oldS: number, newS: number, L: number, dt: number): number {
  return dLine > 0 && oldS > L * 0.5 && newS < L * 0.5 && dt > 0 ? dt * (1 - Math.min(1, Math.max(0, (L - oldS) / dLine))) : 0;
}

type FieldCar = Pick<RaceCar, "s" | "lap" | "lapTime" | "incidentInvalidLap" | "_secIdx" | "_secValid" | "_secT0">;

/** Every car's forward sector exit updates the field's bests (game.js:6152-6163). Race state only. */
export function fieldSectorStep(timing: SectorTiming, c: FieldCar, ds: number, past: number, total: number, sectors?: readonly number[] | null): void {
  const ns = sectorAt(c.s, total, sectors);
  if (ns === c._secIdx) return;
  const fwd = ds > 0 && c._secIdx != null && (c._secIdx < ns || (c._secIdx === 2 && ns === 0));
  if (fwd && c._secValid !== false && c.lap >= 1 && !c.incidentInvalidLap && c._secT0 != null) {
    const e = c.lapTime - (ns === 0 ? past : 0) - c._secT0;
    const idx = c._secIdx as 0 | 1 | 2;
    if (e >= 2 && e < timing.fieldSectorBests[idx]) timing.fieldSectorBests[idx] = e;
  }
  c._secValid = fwd || c._secIdx == null; c._secIdx = ns; c._secT0 = c.lapTime;
}

/**
 * The player's split at a sector line (game.js:6166-6198). Returns the
 * completed sector's index when a split was recorded (the HUD flashes it when
 * the split is >= 2 s), else -1.
 */
export function playerSectorStep(timing: SectorTiming, c: Pick<RaceCar, "s" | "lap" | "lapTime" | "incidentInvalidLap">,
  ds: number, past: number, total: number, sectors?: readonly number[] | null): number {
  const newSector = sectorAt(c.s, total, sectors);
  if (newSector === timing.sectorIdx) return -1;
  let recorded = -1;
  const fwd = ds > 0 && (timing.sectorIdx < newSector || (timing.sectorIdx === 2 && newSector === 0));
  if (fwd) {
    if (c.lap >= 1 && !c.incidentInvalidLap && timing.sectorValid) {
      const elapsed = c.lapTime - (newSector === 0 ? past : 0) - timing.sectorStartT;
      const prevSector = timing.sectorIdx as 0 | 1 | 2;
      const prevBest = timing.sectorBests[prevSector];
      timing.sectorLast[prevSector] = elapsed;
      if (elapsed < prevBest) timing.sectorBests[prevSector] = elapsed;
      recorded = prevSector;
    }
  }
  timing.sectorValid = fwd;
  timing.sectorIdx = newSector;
  timing.sectorStartT = c.lapTime;
  return recorded;
}

/** After a forward line crossing (game.js:6227-6228). */
export function lineReset(timing: SectorTiming | null, c: Pick<RaceCar, "_secT0">): void {
  c._secT0 = 0;
  if (timing) { timing.sectorIdx = 0; timing.sectorStartT = 0; }
}

/** After a backward line crossing, player only (game.js:6239). */
export function lineUndo(timing: SectorTiming, c: Pick<RaceCar, "s" | "lapTime">, total: number, sectors?: readonly number[] | null): void {
  timing.sectorIdx = sectorAt(c.s, total, sectors); timing.sectorStartT = c.lapTime; timing.sectorValid = false;
}
