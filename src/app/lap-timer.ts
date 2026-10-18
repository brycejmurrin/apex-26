/**
 * Start/finish line timing for one car. The lap counter and clock advance on
 * a forward crossing of s = 0 (f1-game RaceControl.lineTransition; the full
 * rule set, sectors and the time-trial out-lap arrive with the race lane).
 * Lap 0 is the out-lap: its time is not a "last" or "best".
 */
export class LapTimer {
  lap = 0;
  /** Seconds into the current lap (0 on the out-lap until the first crossing). */
  lapTime = 0;
  last = Number.NaN;
  best = Number.NaN;

  /** Advance by one step of `dt`; `crossed` is a forward start-line crossing this step. */
  step(dt: number, crossed: boolean): void {
    if (this.lap > 0) this.lapTime += dt;
    if (!crossed) return;
    if (this.lap > 0) {
      this.last = this.lapTime;
      if (!(this.best <= this.lapTime)) this.best = this.lapTime;
    }
    this.lap++;
    this.lapTime = 0;
  }

  reset(): void {
    this.lap = 0; this.lapTime = 0; this.last = Number.NaN; this.best = Number.NaN;
  }
}
