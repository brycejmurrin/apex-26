// RaceControl's pure functions replayed against f1-game js/race/race-control.js
// outputs (tests/fixtures/race, tools/race-fixtures/gen.cjs).
import { describe, expect, it } from "vitest";
import type { RaceCar } from "../../../src/contracts/race";
import {
  LineStep, classify, finishDelay, finishOrder, flagOut, holdCap, lineTransition, runOrder, scQueueFrac, shortRun,
  type LineCross, type PostFinish,
} from "../../../src/race/race-control";
import { classifyRace } from "../../../src/race/results";
import { clone, cmp, fixture, revive } from "./fixture";

type Car = RaceCar & { id: string };

describe("lineTransition", () => {
  const fx = fixture<{ line: unknown[]; defer: unknown[] }>("line-transition");

  it("matches f1-game step by step through crossings, undos and the flag", () => {
    for (const run of fx.line) {
      const { total, lapsTarget, init, other, steps } = revive<{
        total: number; lapsTarget: number; init: Car; other: Car;
        steps: { oldS: number; newS: number; ds: number; raceT: number; dt: number }[];
      }>(run);
      const raw = (run as { steps: { cross: unknown; car: unknown }[] }).steps;
      const car = clone(init), cars = [car, other];
      steps.forEach((st, i) => {
        car.lapTime += st.dt;
        const cross = lineTransition(car, st.oldS, st.newS, st.ds, total, lapsTarget, cars, st.raceT, st.dt);
        expect(cmp(cross), `step ${i}`).toEqual(cmp(raw[i]?.cross, true));
        expect(cmp(clone(car)), `car ${i}`).toEqual(cmp(raw[i]?.car, true));
      });
    }
  });

  it("settles a deferred step in clock order and runs the callbacks", () => {
    for (const d of fx.defer) {
      const c = revive<{ total: number; lapsTarget: number; init: Car[]; oa: number; ob: number; raceT: number; dt: number; order: number[] }>(d);
      const raw = d as { crosses: unknown; cars: unknown; calls: unknown };
      const cars = clone(c.init);
      const step = new LineStep<Car>();
      step.begin(cars);
      const crosses: (LineCross | null)[] = [];
      const calls: number[] = [];
      for (const i of c.order) {
        const car = cars[i] as Car;
        const cross = lineTransition(car, i === 0 ? c.oa : c.ob, 5, 15, c.total, c.lapsTarget, cars, c.raceT, c.dt, step);
        crosses[i] = cross;
        step.defer(car, cross, 5, () => calls.push(i));
      }
      step.end();
      expect(cmp(crosses)).toEqual(cmp(raw.crosses, true));
      expect(cmp(clone(cars))).toEqual(cmp(raw.cars, true));
      expect(calls).toEqual(raw.calls);
    }
  });
});

describe("classification", () => {
  const fx = fixture<unknown[]>("classification");

  it("orders, classifies and times out the result like endRace", () => {
    for (const k of fx) {
      const c = revive<{
        lapsTarget: number; vTop: number; raceT: number; init: Car[]; order: string[];
        classified: (boolean | undefined)[]; finPos: (number | undefined)[]; shortRun: unknown; flagOut: boolean;
        raceT0: number; post0: PostFinish | null; post: PostFinish | null; delay: number;
      }>(k);
      const cars = clone(c.init);
      const order = classifyRace(cars, { vTop: c.vTop, raceT: c.raceT, dsq: cars.filter((x) => x.dsq) });
      expect(order.map((x) => x.id)).toEqual(c.order);
      expect(cars.map((x) => x.classified)).toEqual(c.classified);
      expect(cars.map((x) => x.finPos)).toEqual(c.finPos);
      expect(cmp(shortRun(clone(c.init), c.lapsTarget))).toEqual(cmp(c.shortRun));
      expect(flagOut(c.init, 320)).toBe(c.flagOut);
      const post = c.post0 ? { ...c.post0 } : null;
      expect(finishDelay(clone(c.init), c.raceT, c.lapsTarget, c.raceT0, post)).toBe(c.delay);
      expect(post).toEqual(c.post);
    }
  });

  it("ranks a non-finite finishT last and serves runner penalties on the road", () => {
    const ids = (a: { id: string }[]): string[] => a.map((x) => x.id);
    const early = { id: "early", lap: 6, finishT: 100, penalty: 0 };
    const missing = { id: "missing", lap: 6, finishT: null, penalty: 0 };
    expect(ids([missing, early].sort(finishOrder))).toEqual(["early", "missing"]);
    const pen = { id: "pen", prog: 10000, penalty: 5 }, near = { id: "near", prog: 9950, penalty: 0 };
    expect(ids([pen, near].sort(runOrder(60)))).toEqual(["near", "pen"]);
    expect(classify([], [], [], [])).toEqual([]);
  });
});

describe("safety-car queue", () => {
  it("matches scQueueFrac and holdCap", () => {
    for (const k of fixture<unknown[]>("sc-queue")) {
      const c = revive<{ total: number; cars: Car[]; ci: number; li: number; vTop: number; frac: number; hold: number[]; rankedIdx: number[] }>(k);
      expect(scQueueFrac(c.cars[c.ci], c.cars, c.total, c.cars[c.li], c.vTop)).toBe(c.frac);
      const ranked = c.rankedIdx.map((i) => c.cars[i] as Car);
      expect(ranked.map((x) => holdCap(x, ranked))).toEqual(c.hold);
    }
  });
});
