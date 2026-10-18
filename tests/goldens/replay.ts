// Replay a physics tape golden (tools/oracle/physics.mjs) through the TS
// player step. The TrackQuery is served from the tape: each query the port
// makes must match f1-game's next recorded query (function and every argument,
// Object.is), and gets f1-game's exact result back. A query that does not
// match IS the first divergence, reported with both sides.
//
// The arc reads f1-game made (`curvature`, `bankAngle`) are skipped: the port's
// player path never asks for them, which is the arc rule holding.
import type { BankingOut, PlayerInput, TrackSample } from "../../src/contracts";
import { monza } from "../../src/circuits/defs/monza";
import type { PhysicsTrack, PostLimits, WallLimits } from "../../src/physics/track";
import type { AiTrackQuery } from "../../src/sim/player-step";
import { zoneAt, type AeroZone } from "../../src/physics/aero-zones";
import * as Tyre from "../../src/physics/tyre-model";
import { newLapTiming } from "../../src/sim/player-step-lap";
import {
  CALM,
  createPlayerStep,
  defaultDriveTune,
  DRY,
  GREEN_FLAG,
  NO_PITS,
  type PlayerCar,
  type PlayerWorld,
} from "../../src/sim/player-step";
import { readGolden } from "./decode";

type Entry = [string, ...unknown[]];
export interface TapeGolden {
  header: { trace: string; steps: number; f1Sha: string };
  initial: { car: Record<string, unknown>; world: Record<string, unknown> };
  steps: { input: Record<string, unknown>; state: Record<string, number | boolean | null>; raceT: number; tape: Entry[] }[];
}

export const TRACES = ["straight-line-accel", "steady-corner-load", "trail-brake-into-rotation", "off-track-recovery"] as const;

export class TapeDivergence extends Error {}

const ARC = new Set(["curvature", "bankAngle"]);

/** A PhysicsTrack whose every query is served, in order, from one step's tape. */
export function tapeTrack(
  total: number,
  street: boolean,
  n = 0,
): { track: PhysicsTrack; ai: AiTrackQuery; load(step: number, tape: Entry[]): void; finish(): void; arcSkipped: () => number } {
  let tape: Entry[] = [];
  let i = 0;
  let stepNo = -1;
  let arc = 0;
  function next(fn: string, args: unknown[]): Entry {
    // f1-game's arc reads the port never makes (the player's c.kCur) are
    // skipped; an arc read the port DOES make (an AI car) is matched like any.
    while (!ARC.has(fn) && i < tape.length && ARC.has((tape[i] as Entry)[0])) {
      i++;
      arc++;
    }
    const e = tape[i];
    if (!e) throw new TapeDivergence(`step ${stepNo}: port asked ${fn}(${args.join(", ")}) but f1-game made no more queries`);
    const same = e[0] === fn && args.every((a, k) => Object.is(a, e[k + 1]));
    if (!same) throw new TapeDivergence(`step ${stepNo} query ${i}: port asked ${fn}(${args.join(", ")}), f1-game asked ${e[0]}(${e.slice(1, 1 + args.length).join(", ")})`);
    i++;
    return e;
  }
  const v3 = (dst: number[], src: unknown): void => {
    const a = src as number[];
    dst[0] = a[0] as number;
    dst[1] = a[1] as number;
    dst[2] = a[2] as number;
  };
  const track: PhysicsTrack = {
    length: total,
    street,
    sample(s: number, out: TrackSample): TrackSample {
      const e = next("sample", [s]);
      v3(out.p, e[2]);
      v3(out.t, e[3]);
      v3(out.r, e[4]);
      out.hw = e[5] as number;
      return out;
    },
    banking(s: number, x: number, out: BankingOut, smooth?: boolean): BankingOut | null {
      const e = next("banking", [s, x, smooth === undefined ? null : !!smooth]);
      const r = e[4] as [number, number] | null;
      if (!r) return null;
      out.dy = r[0];
      out.roll = r[1];
      return out;
    },
    onKerb(s: number, x: number): 0 | 1 {
      return next("onKerb", [s, x])[3] as 0 | 1;
    },
    inPitLane(s: number, x: number): boolean {
      return next("inPitLane", [s, x])[3] as boolean;
    },
    wallAt(s: number, side: number): number {
      return next("wallAt", [s, side])[3] as number;
    },
    wrapS(s: number): number {
      s %= total;
      return s < 0 ? s + total : s;
    },
    wallLimits(s: number, x: number, out: WallLimits, _post: PostLimits, previous?: { s: number; x: number } | null): WallLimits {
      const e = next("wallLimits", [s, x]);
      const prev = e[3] as [number, number] | null;
      if (!!prev !== !!previous || (prev && previous && (!Object.is(prev[0], previous.s) || !Object.is(prev[1], previous.x))))
        throw new TapeDivergence(`step ${stepNo}: wallLimits previous differs`);
      const r = e[4] as [number, number, number, number];
      out.r = r[0];
      out.l = r[1];
      out.laneMin = r[2];
      out.side = r[3];
      return out;
    },
  };
  const _ln = { x: 0, w: 0 },
    _atk = { q: 0, toTurnIn: 0 };
  const ai: AiTrackQuery = {
    n,
    curvature: (s) => next("curvature", [s])[2] as number,
    bankAngle: (s) => next("bankAngle", [s])[2] as number,
    lineAt(s, fam) {
      const r = next("lineAt", [s, fam === undefined ? null : fam])[3] as [number, number];
      _ln.x = r[0];
      _ln.w = r[1];
      return _ln;
    },
    pathK: (s) => next("pathK", [s])[2] as number,
    attackAt(s) {
      const r = next("attackAt", [s])[2] as [number, number];
      _atk.q = r[0];
      _atk.toTurnIn = r[1];
      return _atk;
    },
    attackQ: (k) => next("attackQ", [k])[2] as number,
  };
  return {
    track,
    ai,
    load(step: number, t: Entry[]): void {
      tape = t;
      i = 0;
      stepNo = step;
    },
    finish(): void {
      while (i < tape.length && ARC.has((tape[i] as Entry)[0])) {
        i++;
        arc++;
      }
      if (i < tape.length) {
        const e = tape[i] as Entry;
        throw new TapeDivergence(`step ${stepNo}: f1-game made ${tape.length - i} more queries, next ${e[0]}(${e.slice(1, 3).join(", ")})`);
      }
    },
    arcSkipped: () => arc,
  };
}

/** The golden's initial car: {$undef} → present-but-undefined, {$obj} → object. */
export function carFrom(raw: Record<string, unknown>, cars?: PlayerCar[]): PlayerCar {
  const c: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as { $undef?: boolean; $obj?: Record<string, unknown>; $car?: number };
      if (o.$undef) c[k] = undefined;
      else if (o.$obj) c[k] = structuredClone(o.$obj);
      else if (o.$car !== undefined) c[k] = o.$car; // resolved by fieldFrom once every car exists
      else c[k] = v;
    } else c[k] = v;
  }
  void cars;
  return c as unknown as PlayerCar;
}

/** Every car of a race golden, with {$car: i} references resolved to the car objects. */
export function fieldFrom(raws: Record<string, unknown>[]): PlayerCar[] {
  const cars = raws.map((r) => carFrom(r));
  raws.forEach((r, i) => {
    for (const [k, v] of Object.entries(r)) {
      const o = v as { $car?: number } | null;
      if (o && typeof o === "object" && o.$car !== undefined) (cars[i] as unknown as Record<string, unknown>)[k] = o.$car >= 0 ? cars[o.$car] : null;
    }
  });
  return cars;
}

/** A scripted __apex.setInput object as the full PlayerInput (absent = f1-game's defaults). */
export function inputFrom(raw: Record<string, unknown>): PlayerInput {
  return {
    steer: (raw["steer"] as number | undefined) ?? 0,
    throttle: !!raw["throttle"],
    brake: !!raw["brake"],
    throttleLevel: (raw["throttleLevel"] as number | undefined) ?? 1,
    brakeLevel: (raw["brakeLevel"] as number | undefined) ?? 1,
    shiftUp: !!raw["shiftUp"],
    shiftDown: !!raw["shiftDown"],
    aero: !!raw["aero"],
    aeroToggle: false,
    overtake: !!raw["overtake"],
    boost: false,
  };
}

export interface ReplayResult {
  /** First step whose state differs from f1-game's under Object.is, or -1. */
  firstDiff: number;
  firstDiffField: string | null;
  /** Steps replayed before the run stopped (a tape divergence stops it). */
  steps: number;
  tapeError: string | null;
  /** max |port − f1-game| over the numeric state fields at the last replayed step. */
  endDrift: number;
  arcSkipped: number;
}

export function replay(name: (typeof TRACES)[number]): ReplayResult {
  const g = readGolden<TapeGolden>(`physics-tape-${name}.json.gz`);
  const w = g.initial.world;
  const tape = tapeTrack(w["trackTotal"] as number, !!w["street"]);
  const tune = defaultDriveTune();
  tune.PACE = w["PACE"] as number;
  tune.PLAYER_GRIP = w["PLAYER_GRIP"] as number;
  tune.FRONT_GRIP = w["FRONT_GRIP"] as number;
  tune.DRIFT = w["DRIFT"] as number;
  tune.YAW_INERTIA = w["YAW_INERTIA"] as number;
  tune.YAW_DAMP = w["YAW_DAMP"] as number;
  tune.WHEELBASE = w["WHEELBASE"] as number;
  tune.STEER_EXPO = w["STEER_EXPO"] as number;
  tune.STEER_MAX_SLIP = w["STEER_MAX_SLIP"] as number;
  tune.STEER_SPEED_REF = w["STEER_SPEED_REF"] as number;
  const tyres = Tyre.create({
    raceTyreWear: "off",
    track: { length: w["trackTotal"] as number, def: monza },
    weatherArc: null,
    raceWeather: "dry",
    lapsTarget: w["lapsTarget"] as number,
    session: w["session"] as string,
    LAT_MAX: w["LAT_MAX"] as number,
    aTop: () => w["aTop"] as number,
    vTop: () => w["vTop"] as number,
  });
  const world: PlayerWorld = {
    track: tape.track,
    def: monza,
    tune,
    raceT: w["raceT"] as number,
    state: "race",
    session: w["session"] as PlayerWorld["session"],
    lapsTarget: w["lapsTarget"] as number,
    dirtyAir: w["raceDirtyAir"] as PlayerWorld["dirtyAir"],
    aeroMode: w["raceAeroMode"] as PlayerWorld["aeroMode"],
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
  };
  const ps = createPlayerStep(world);
  const car = carFrom(g.initial.car);
  const res: ReplayResult = { firstDiff: -1, firstDiffField: null, steps: 0, tapeError: null, endDrift: 0, arcSkipped: 0 };
  for (const [i, st] of g.steps.entries()) {
    tape.load(i, st.tape);
    try {
      ps.step(car, 1 / 60, inputFrom(st.input));
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
    for (const [k, want] of Object.entries(st.state)) {
      const got = (car as unknown as Record<string, unknown>)[k];
      const g2 = got === undefined ? null : got;
      if (!Object.is(g2, want) && res.firstDiff < 0) {
        res.firstDiff = i;
        res.firstDiffField = `${k}: port ${String(g2)} f1-game ${String(want)}`;
      }
      if (typeof want === "number" && typeof g2 === "number" && !Object.is(g2, want)) drift = Math.max(drift, Math.abs(g2 - want));
    }
    if (!Object.is(world.raceT, st.raceT) && res.firstDiff < 0) {
      res.firstDiff = i;
      res.firstDiffField = `raceT: port ${world.raceT} f1-game ${st.raceT}`;
    }
    res.endDrift = drift;
  }
  res.arcSkipped = tape.arcSkipped();
  return res;
}
