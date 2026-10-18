// The qualifying model replayed against f1-game Quali.create(G).preview():
// quasi-steady laps at several PACE settings, execution draws, driven laps, NO TIME.
import { describe, expect, it } from "vitest";
import { computeQuali, medalFor, paceLap, freeFor, qualiOrder, referencePole, restoreRows, persistRows, type QualiCar, type QualiEnv, type QualiTrack } from "../../../src/race/quali";
import { fixture, revive } from "./fixture";

interface Case {
  total: number; n: number; kp: { a: number; f1: number; b: number; f2: number }; env: QualiEnv;
  cars: (QualiCar & { grip: number })[]; cons: Record<string, number>; round: number; seed: number;
  driven: number | string | Record<string, number>; rows: unknown; pole: number; lap0: number;
}

const trackOf = (c: Case, id: string): QualiTrack => ({
  n: c.n, total: c.total, id,
  absCurvature: (s) => c.kp.a * Math.sin(2 * Math.PI * c.kp.f1 * s / c.total) + c.kp.b * Math.cos(2 * Math.PI * c.kp.f2 * s / c.total),
});

describe("qualifying model", () => {
  const fx = revive<{ cases: Case[]; medals: { t: number; pole: number; m: string | null }[] }>(fixture("quali-model"));

  it("classifies the field exactly like f1-game", () => {
    fx.cases.forEach((c, k) => {
      const track = trackOf(c, "trk" + k);
      const driven = c.driven === "Inf" ? Infinity : c.driven as number | Record<string, number>;
      const rows = computeQuali({
        env: c.env, track, cars: c.cars, round: c.round, seed: c.seed, driven,
        grip: (car) => car.grip, consistency: (car) => c.cons[car.code] as number,
      });
      expect(rows, `case ${k}`).toEqual(c.rows);
      expect(referencePole(c.env, track, 1), `case ${k}`).toBe(c.pole);
      const car0 = c.cars[0] as QualiCar;
      expect(paceLap(c.env, track, freeFor(c.env, car0.tierV, car0.skill), 1), `case ${k}`).toBe(c.lap0);
    });
  });

  it("awards medals against the reference pole", () => {
    for (const m of fx.medals) expect(medalFor(m.t, m.pole)).toBe(m.m);
  });

  it("maps a persisted order back onto the live field only when it fits", () => {
    const c = fx.cases[0] as Case;
    const rows = computeQuali({ env: c.env, track: trackOf(c, "x"), cars: c.cars, round: 0, seed: 1, driven: 90, grip: () => 1, consistency: () => 50 });
    const saved = persistRows(rows);
    expect(saved?.length).toBe(c.cars.length);
    const back = restoreRows({ order: saved, qualiTrack: "x", here: "x", mode: "gp", cars: c.cars });
    expect(qualiOrder(back, c.cars)?.map((x) => x.driverId)).toEqual(rows?.map((r) => r.driverId));
    expect(restoreRows({ order: saved, qualiTrack: "y", here: "x", mode: "gp", cars: c.cars })).toBeNull();
    expect(restoreRows({ order: saved?.slice(1), here: "x", mode: "gp", cars: c.cars })).toBeNull();
    expect(persistRows(computeQuali({ env: c.env, track: trackOf(c, "x"), cars: c.cars, round: 0, seed: 1, grip: () => 1, consistency: () => 50 }))).toBeNull();
  });
});
