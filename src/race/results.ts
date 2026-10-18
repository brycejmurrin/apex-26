/**
 * RESULTS: endRace's classification pipeline as one pure function.
 *
 * Ported from f1-game js/game.js:2925-2949 (main @ 2026-10-18): finishers by
 * laps then clock (`finishOrder`), runners by progress less road-served
 * penalties (`runOrder` at the race's average speed), retirements furthest
 * first, then `classify` (laps first, the 90 % line), DSQs last. The
 * disqualification list (SportingRegs.applyCompoundRule) is computed by the
 * caller and passed in; a forced order (a host's) replaces the classification.
 */
import type { RaceCar } from "../contracts/race";
import { classify, finishOrder, runOrder } from "./race-control";

export type ResultCar = Pick<RaceCar, "finished" | "retired" | "dsq" | "lap" | "finishT" | "penalty" | "prog" | "classified" | "finPos">;

export interface ClassifyOpts<C> {
  /** vTop(), m/s: floors the average speed a runner's penalty is served at. */
  readonly vTop: number;
  readonly raceT: number;
  /** Cars disqualified this race, in the order the rule returned them. */
  readonly dsq?: readonly C[];
  /** A host's order: used as given (netOrder). */
  readonly forcedOrder?: readonly C[] | null;
}

/** Classify the field and stamp `finPos` (1-based) on every car in the order. */
export function classifyRace<C extends ResultCar>(cars: readonly C[], opts: ClassifyOpts<C>): C[] {
  const dsq = opts.dsq || [];
  const fin = cars.filter((c) => c.finished && !c.retired && !c.dsq).sort(finishOrder);
  const run = cars.filter((c) => !c.finished && !c.retired && !c.dsq);
  const leadProg = Math.max(0, ...fin.concat(run).map((c) => c.prog || 0));
  run.sort(runOrder(Math.max(0.25 * opts.vTop, leadProg / Math.max(1, opts.raceT))));
  const out = cars.filter((c) => c.retired).sort((a, b) => b.prog - a.prog);
  const order = opts.forcedOrder ? opts.forcedOrder.slice() : classify(cars, fin, run, out).concat(dsq);
  order.forEach((c, i) => { c.finPos = i + 1; });
  return order;
}
