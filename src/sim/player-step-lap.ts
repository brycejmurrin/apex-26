/**
 * Lap-line and sector timing the player step advances every tick.
 *
 * `lineTransition` is f1-game js/race/race-control.js:102-137 verbatim, with
 * the finish policy (`settleLine`, :62-66, which needs the whole field's
 * `flagOut`) handed to the caller; `sectorAt` is js/game.js:1048-1055.
 * TODO(lane-race): the batched line step (beginLineStep / settleLineStep /
 * endLineStep) and flagOut belong to the race rules port.
 */

/** The car fields the line transition owns. */
export interface LineCar {
  finished: boolean;
  lap: number;
  lapTime: number;
  fuelLap?: number | null | undefined;
  fuelRestartLaps?: number | undefined;
  _lapTimeAtLine?: number | undefined;
  _recross?: boolean | undefined;
}

export interface LineCross {
  direction: 1 | -1;
  changed: boolean;
  lapDone: number | null;
  flagged: boolean;
  recross?: boolean;
  lapValid?: boolean;
}

/** One pending finish decision: race-control.js:123-124. */
export interface LineEntry<C extends LineCar> {
  readonly c: C;
  readonly cross: LineCross;
  readonly target: number;
  readonly time: number;
}

export function lineTransition<C extends LineCar>(
  c: C,
  oldS: number,
  newS: number,
  ds: number,
  total: number,
  lapsTarget: number,
  raceT: number,
  dt: number,
  settle: (e: LineEntry<C>) => void,
): LineCross | null {
  if (!c || c.finished || !(total > 0)) return null;
  if (ds > 0 && oldS > total * 0.5 && newS < total * 0.5) {
    let over = 0;
    if (dt > 0 && Number.isFinite(dt)) {
      const frac = (total - oldS) / ds;
      if (Number.isFinite(frac)) over = dt * (1 - Math.min(1, Math.max(0, frac)));
    }
    const lapDone = Math.max(0, (c.lapTime || 0) - over);
    const recross = !!c._recross;
    c._recross = false;
    c.lap = (c.lap || 0) + 1;
    c.fuelLap = Math.max(c.fuelLap || 0, c.lap + (c.fuelRestartLaps || 0));
    c._lapTimeAtLine = lapDone;
    c.lapTime = (c.lapTime || 0) - lapDone;
    const cross: LineCross = { direction: 1, changed: true, lapDone, flagged: false, recross };
    settle({ c, cross, target: Number(lapsTarget), time: Number.isFinite(raceT) ? Math.max(0, raceT - over) : 0 });
    return cross;
  }
  if (ds < 0 && oldS < total * 0.5 && newS > total * 0.5) {
    if (!(c.lap > 0)) return { direction: -1, changed: false, lapDone: null, flagged: false };
    c.lap--;
    c.lapTime = c._lapTimeAtLine != null ? c._lapTimeAtLine : c.lapTime;
    c._recross = true;
    return { direction: -1, changed: true, lapDone: null, flagged: false };
  }
  return null;
}

/**
 * race-control.js:62-66 for a solo field: flagged at full distance. The
 * leader-home rule (`flagOut`) needs the whole field.
 */
export function settleSolo<C extends LineCar & { finishT?: number | undefined; _nFallback?: boolean | undefined }>(e: LineEntry<C>): void {
  const { c, cross, time, target } = e;
  cross.flagged = !c._nFallback && target > 0 && c.lap > target;
  if (cross.flagged) {
    c.finished = true;
    c.finishT = time;
  }
}

/** Curated `def.sectors` splits when present; equal thirds otherwise. game.js:1048. */
export function sectorAt(frac: number, sectors: readonly number[] | null | undefined): 0 | 1 | 2 {
  if (sectors && sectors.length === 2) {
    return frac < (sectors[0] as number) ? 0 : frac < (sectors[1] as number) ? 1 : 2;
  }
  return frac < 1 / 3 ? 0 : frac < 2 / 3 ? 1 : 2;
}

/** The player's curated split state (f1-game `lapRec`, js/race/lap-record.js) and the field's sector bests. */
export interface LapTiming {
  sectorIdx: number;
  sectorStartT: number;
  sectorValid: boolean;
  sectorBests: [number, number, number];
  sectorLast: [number, number, number];
  fieldSectorBests: [number, number, number];
}

export function newLapTiming(): LapTiming {
  return {
    sectorIdx: 0,
    sectorStartT: 0,
    sectorValid: true,
    sectorBests: [Infinity, Infinity, Infinity],
    sectorLast: [0, 0, 0],
    fieldSectorBests: [Infinity, Infinity, Infinity],
  };
}
