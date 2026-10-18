/**
 * The race store's constructor: a fresh `RaceState` (src/contracts/race.ts)
 * for one session. The values are f1-game's at race arm (js/game.js:2594-2624:
 * `raceT = 0`, `countT = 0`, `lightsLit = 0`, a fresh lapRec, a reset
 * RaceControl).
 */
import type { RaceCar, RaceSession, RaceSettings, RaceState, RaceWeather } from "../contracts/race";
import { createRaceControl } from "./race-control";
import { freshTiming } from "./sectors";
import { freshCountdown } from "./start-lights";

export interface RaceStateInit {
  session: RaceSession;
  settings: RaceSettings;
  cars: RaceCar[];
  weather: RaceWeather;
  lapsTarget: number;
}

export function createRaceState(init: RaceStateInit): RaceState {
  return {
    session: init.session,
    phase: "count",
    settings: init.settings,
    cars: init.cars,
    ranked: init.cars.slice(),
    raceT: 0,
    raceT0: 0,
    lapsTarget: init.lapsTarget,
    countdown: freshCountdown(),
    raceControl: createRaceControl(init.settings.cautions),
    weather: init.weather,
    timing: freshTiming(),
  };
}

/** Rank the field by cumulative progress, leader first, retirements excluded (game.js:4475-4477). TODO(lane-race): rankFinishers (game.js:4483) re-ranks two or more finishers by the flag order. */
export function rankField(st: RaceState): RaceCar[] {
  st.ranked = st.cars.filter((c) => !c.retired).sort((a, b) => b.prog - a.prog);
  return st.ranked;
}
