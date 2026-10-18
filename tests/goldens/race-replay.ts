// Replay a race golden (tools/oracle/race.mjs) through the TS race step, with
// every track query served from the golden's tape (see replay.ts). Reports the
// first step and car/field where the port differs from f1-game.
import { monza } from "../../src/circuits/defs/monza";
import { zoneAt, type AeroZone } from "../../src/physics/aero-zones";
import * as Tyre from "../../src/physics/tyre-model";
import { createRaceStep } from "../../src/sim/ai/race-step";
import { CALM, defaultDriveTune, DRY, GREEN_FLAG, NO_PITS, type PlayerCar } from "../../src/sim/player-step";
import { newLapTiming } from "../../src/sim/player-step-lap";
import { readGolden } from "./decode";
import { fieldFrom, inputFrom, TapeDivergence, tapeTrack } from "./replay";

type Entry = [string, ...unknown[]];
interface RaceGolden {
  header: { trace: string; steps: number };
  initial: { cars: Record<string, unknown>[]; world: Record<string, unknown>; active: number[]; playerIdx: number; paceRef: number[] | null };
  steps: { input: Record<string, unknown> | null; cars: Record<string, number | boolean | null>[]; raceT: number; rngState: number; tape: Entry[] }[];
}

export const RACES = ["player-2ai", "3ai-start"] as const;

export interface RaceResult {
  firstDiff: number;
  firstDiffField: string | null;
  steps: number;
  tapeError: string | null;
  endDrift: number;
}

export function replayRace(name: (typeof RACES)[number]): RaceResult {
  const g = readGolden<RaceGolden>(`race-${name}.json.gz`);
  const w = g.initial.world;
  const total = w["trackTotal"] as number;
  const tape = tapeTrack(total, !!w["street"], w["trackN"] as number);
  const tune = defaultDriveTune();
  for (const k of ["PACE", "PLAYER_GRIP", "FRONT_GRIP", "DRIFT", "YAW_INERTIA", "YAW_DAMP", "WHEELBASE", "STEER_EXPO", "STEER_MAX_SLIP", "STEER_SPEED_REF"] as const)
    tune[k] = w[k] as number;
  const cars = fieldFrom(g.initial.cars);
  const player = (cars[g.initial.playerIdx] as PlayerCar | undefined) ?? null;
  let rng = (w["rngState"] as number) >>> 0;
  const paceRef = new Float32Array(w["trackN"] as number);
  if (g.initial.paceRef) paceRef.set(g.initial.paceRef);
  const tyres = Tyre.create({
    raceTyreWear: "off",
    track: { length: total, def: monza },
    weatherArc: null,
    raceWeather: "dry",
    lapsTarget: w["lapsTarget"] as number,
    session: w["session"] as string,
    LAT_MAX: w["LAT_MAX"] as number,
    aTop: () => w["aTop"] as number,
    vTop: () => w["vTop"] as number,
  });
  const world = {
    track: tape.track,
    def: monza,
    tune,
    raceT: w["raceT"] as number,
    state: "race" as const,
    session: w["session"] as "race",
    lapsTarget: w["lapsTarget"] as number,
    dirtyAir: w["raceDirtyAir"] as "classic",
    aeroMode: w["raceAeroMode"] as "manual",
    gearsManual: false,
    autoThrottle: false,
    liveInput: false,
    soundOn: !!w["soundOn"],
    weather: DRY,
    wind: CALM,
    pits: NO_PITS,
    raceCtl: GREEN_FLAG,
    tyres,
    aeroZoneAt: (s: number) => !!zoneAt((w["aeroZones"] as AeroZone[] | undefined) ?? [], w["trackTotal"] as number, s),
    timing: newLapTiming(),
    netPlay: { owns: () => false },
    player,
    ai: {
      track: tape.ai,
      cars,
      difficulty: w["difficulty"] as string,
      aiPace: (w["aiPace"] as "scripted") ?? "scripted",
      launchT0: 0,
      rnd: () => {
        rng = (Math.imul(rng, 1103515245) + 12345) >>> 0;
        return rng / 0x100000000;
      },
      luckSeed: w["simSeed"] as number,
      round: w["raceRound"] as number,
      leadHuman: null,
      parked: [] as PlayerCar[],
      paceRef,
    },
  };
  const race = createRaceStep(world);
  const res: RaceResult = { firstDiff: -1, firstDiffField: null, steps: 0, tapeError: null, endDrift: 0 };
  for (const [i, st] of g.steps.entries()) {
    tape.load(i, st.tape);
    const inp = st.input ? inputFrom(st.input) : null;
    try {
      race.step(1 / 60, () => inp);
      tape.finish();
    } catch (e) {
      if (!(e instanceof TapeDivergence)) throw e;
      res.tapeError = e.message;
      if (res.firstDiff < 0) {
        res.firstDiff = i;
        res.firstDiffField = "(track query)";
      }
      break;
    }
    res.steps = i + 1;
    let drift = 0;
    st.cars.forEach((want, k) => {
      const car = cars[g.initial.active[k] as number] as unknown as Record<string, unknown>;
      for (const [f, wv] of Object.entries(want)) {
        let got = car[f];
        if (got && typeof got === "object") got = cars.indexOf(got as PlayerCar);
        else if ((f === "passOf" || f === "passFailOf" || f === "_qOf" || f === "_alPrev") && got == null) got = -1;
        const g2 = got === undefined ? null : got;
        if (!Object.is(g2, wv) && res.firstDiff < 0) {
          res.firstDiff = i;
          res.firstDiffField = `car ${g.initial.active[k]} ${f}: port ${String(g2)} f1-game ${String(wv)}`;
        }
        if (typeof wv === "number" && typeof g2 === "number" && !Object.is(g2, wv)) drift = Math.max(drift, Math.abs(g2 - wv));
      }
    });
    if (!Object.is(world.raceT, st.raceT) && res.firstDiff < 0) {
      res.firstDiff = i;
      res.firstDiffField = `raceT: port ${world.raceT} f1-game ${st.raceT}`;
    }
    if (!Object.is(rng, st.rngState) && res.firstDiff < 0) {
      res.firstDiff = i;
      res.firstDiffField = `rngState: port ${rng} f1-game ${st.rngState}`;
    }
    res.endDrift = drift;
  }
  return res;
}
