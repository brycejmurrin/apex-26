// Overtake mode, reliability, hash32, season points and start lights replayed
// against f1-game outputs (tests/fixtures/race, tools/race-fixtures/gen.cjs).
import { describe, expect, it } from "vitest";
import type { ReliabilityLevel } from "../../../src/contracts/race";
import { fnv1a, unit } from "../../../src/race/hash32";
import * as O from "../../../src/race/overtake-mode";
import * as Rel from "../../../src/race/reliability";
import {
  CLASSIC_POINTS, POINTS, award, canRace, netPts, payTable, rank, rankTeams, type AwardCar, type Scoring, type SeasonRecord,
} from "../../../src/race/points";
import type { ShortRun } from "../../../src/race/race-control";
import { countCredit, lampsFor, type LampTrack } from "../../../src/race/start-lights";
import { clone, cmp, fixture, revive } from "./fixture";

describe("hash32", () => {
  it("matches Hash32.unit and fnv1a", () => {
    for (const c of revive<{ seed: number; parts: (string | number)[]; unit: number; fnv: number }[]>(fixture("hash32"))) {
      expect(unit(c.seed, ...c.parts)).toBe(c.unit);
      expect(fnv1a(c.parts.join("|"))).toBe(c.fnv);
    }
  });
});

describe("overtake mode", () => {
  const fx = revive<{
    runs: { track: O.OtTrack; human: boolean; steps: {
      s: number; lap: number; gap: number; open: boolean; gate: boolean; speedOK: boolean; fire: boolean; thrust: boolean;
      pushS?: number; started: boolean; frac: number; car: Record<string, unknown>;
    }[] }[];
    crossed: { a: number; b: number; at: number; L: number; v: boolean }[];
    energy: number;
  }>(fixture("overtake-mode"));

  it("earns, grants, deploys and lapses like f1-game", () => {
    for (const run of fx.runs) {
      const car = { s: 0, lap: 0, human: run.human } as O.OtCar;
      O.reset(car);
      const track = { ...run.track };
      run.steps.forEach((st, i) => {
        car.s = st.s; car.lap = st.lap;
        O.lines(car, track, st.gap, st.open);
        O.arm(car, st.gate, st.speedOK);
        const started = O.prepare(car, st.fire, st.gate, st.speedOK, st.pushS);
        const frac = O.consume(car, 1 / 60, st.thrust, st.pushS);
        expect(started, `step ${i}`).toBe(st.started);
        expect(frac, `step ${i}`).toBe(st.frac);
        expect(cmp({ otE: car.otE, otOn: car.otOn, otEarned: car.otEarned, otArmed: car.otArmed, otT: car.otT, _otS: car._otS, _otLap: car._otLap, _otHold: car._otHold }), `step ${i}`)
          .toEqual(cmp(st.car));
      });
    }
  });

  it("tests the line wrap-safe", () => {
    for (const c of fx.crossed) expect(O.crossed(c.a, c.b, c.at, c.L)).toBe(c.v);
    expect(O.energy()).toBe(fx.energy);
  });
});

describe("reliability", () => {
  it("draws the same failure plan per seed, round and level", () => {
    type RCar = Rel.ReliabilityCar & { code: string };
    for (const c of revive<{ dev: Record<string, number>; opts: { level: string; seed: number; round: number; build: number; networked: boolean }; init: RCar[]; plan: unknown; cars: unknown }[]>(fixture("reliability"))) {
      const cars = clone(c.init);
      Rel.arm(cars, { ...c.opts, paceMult: (id) => Math.min(1.1, Math.max(0.9, 1 + (c.dev[id as string] || 0) * 0.0025)) });
      expect(cmp(Rel.plan(cars))).toEqual(cmp(c.plan));
      expect(cmp(cars.map((x) => ({ dnfAt: x.dnfAt, dnfWhy: x.dnfWhy })))).toEqual(cmp(c.cars));
    }
    expect(Rel.isLevel("real" satisfies ReliabilityLevel)).toBe(true);
    expect(Rel.isLevel("bogus")).toBe(false);
  });
});

describe("season points", () => {
  const fx = fixture<{ pay: unknown[]; seasons: unknown[] }>("season-points");

  it("pays the shortened-race scale", () => {
    for (const p of revive<{ table: number[]; scoring: Scoring; run: ShortRun | null; out: number[] }[]>(fx.pay)) {
      // payTable keys the classic halving on identity with CLASSIC_POINTS.
      const table = p.table.join() === CLASSIC_POINTS.join() ? CLASSIC_POINTS : p.table;
      expect([...payTable(table, p.scoring, p.run)]).toEqual(p.out);
    }
  });

  it("awards rounds, sprints, fastest-lap points and ranks like SeasonCal", () => {
    for (const raw of fx.seasons) {
      const s = revive<{
        cfg: { trackIds: string[]; points: string; flPoint: boolean; drop: number; sprint: boolean | "rounds"; sprintIds: string[] };
        awards: { stage: Scoring; table: number[]; order: AwardCar[]; fastest: string | null; run: ShortRun | null; scored: Scoring | null; season: unknown }[];
        standings: string[]; net: Record<string, number>; teams: string[];
      }>(raw);
      const season: SeasonRecord = { round: 0, pts: {}, teamPts: {}, driverCodes: {}, finishes: {}, roundPts: {} };
      const rounds = s.cfg.trackIds.length;
      const table = s.cfg.points === "classic" ? CLASSIC_POINTS : POINTS;
      s.awards.forEach((a, i) => {
        expect([...table]).toEqual(a.table);
        const scored = award(season, a.order, a.fastest, a.run, { scoring: a.stage, table, flPoint: s.cfg.flPoint, rounds });
        expect(scored, `award ${i}`).toBe(a.scored);
        const want = revive<Record<string, unknown>>((raw as { awards: { season: unknown }[] }).awards[i]?.season);
        delete want["config"];
        expect(cmp(clone(season)), `award ${i}`).toEqual(cmp(want));
      });
      expect(canRace(season, rounds)).toBe(false);
      const ids = s.standings.slice().sort();
      expect(ids.slice().sort((a, b) => rank(season, a, b, s.cfg, rounds))).toEqual(s.standings);
      const teams = [{ id: "a", tier: 0 }, { id: "b", tier: 1 }, { id: "c", tier: 2 }, { id: "d", tier: 2 }];
      expect(["a", "b", "c", "d"].sort((a, b) => rankTeams(season, a, b, teams))).toEqual(s.teams);
      expect(Object.fromEntries(ids.map((id) => [id, netPts(season, id, s.cfg, rounds)]))).toEqual(s.net);
    }
  });
});

describe("start lights", () => {
  const fx = revive<{ credit: { w: number; d: number; dr: number; v: number }[]; lamps: { track: LampTrack; lamps: number[][] | null }[] }>(fixture("start-lights"));
  it("tops up the countdown on the wall clock", () => {
    for (const c of fx.credit) expect(countCredit(c.w, c.d, c.dr)).toBe(c.v);
  });
  it("hangs the lamps on the nearest start gantry or the gate", () => {
    for (const c of fx.lamps) expect(lampsFor(c.track)).toEqual(c.lamps);
  });
});

