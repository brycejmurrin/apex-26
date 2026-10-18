// Hand-built cases for the race rules that live inside f1-game js/game.js
// (sectors :1048/:6150-6198, the countdown :4366-4413, the grid :1602-1752),
// which cannot be loaded into a VM on their own.
import { describe, expect, it } from "vitest";
import { champOrder, gridOrderFor, gridRule, gridUp } from "../../../src/race/grid";
import { sweepPassedFailures } from "../../../src/race/reliability";
import { fieldSectorStep, freshTiming, playerSectorStep, s3Past, sectorAt } from "../../../src/race/sectors";
import { COUNTDOWN_S, freshCountdown, stepCountdown } from "../../../src/race/start-lights";

describe("sectors", () => {
  it("uses curated splits when a circuit has them, thirds otherwise", () => {
    expect(sectorAt(100, 3000)).toBe(0);
    expect(sectorAt(1500, 3000)).toBe(1);
    expect(sectorAt(-10, 3000)).toBe(2);
    expect(sectorAt(1500, 3000, [0.6, 0.8])).toBe(0);
    expect(sectorAt(2100, 3000, [0.6, 0.8])).toBe(1);
  });

  it("times the player's split and the field best, S3 closing at the line", () => {
    const t = freshTiming(2);
    const car = { s: 2990, lap: 1, lapTime: 30, incidentInvalidLap: false, _secIdx: 2 as number | null, _secValid: true, _secT0: 0 as number | null };
    t.sectorStartT = 0;
    // forward across the line inside the step: oldS 2990 → 10 over a 20 m step, half of 1/60 s past it
    car.s = 10; car.lapTime = 30 + 1 / 60;
    const past = s3Past(20, 2990, 10, 3000, 1 / 60);
    expect(past).toBeCloseTo(1 / 120, 12);
    expect(playerSectorStep(t, car, 20, past, 3000)).toBe(2);
    expect(t.sectorLast[2]).toBe(30 + 1 / 60 - past);
    expect(t.sectorBests[2]).toBe(t.sectorLast[2]);
    expect(t.sectorIdx).toBe(0);
    fieldSectorStep(t, car, 20, past, 3000);
    expect(t.fieldSectorBests[2]).toBe(30 + 1 / 60 - past);
    // a backward entry makes the next split untrustworthy
    car.s = 2995;
    expect(playerSectorStep(t, car, -15, 0, 3000)).toBe(-1);
    expect(t.sectorValid).toBe(false);
  });

  it("skips the formation lap's S3 and incident-invalidated laps", () => {
    const t = freshTiming(2);
    expect(playerSectorStep(t, { s: 5, lap: 0, lapTime: 12, incidentInvalidLap: false }, 10, 0, 3000)).toBe(-1);
    t.sectorIdx = 0; t.sectorValid = true;
    expect(playerSectorStep(t, { s: 1100, lap: 2, lapTime: 25, incidentInvalidLap: true }, 10, 0, 3000)).toBe(-1);
  });
});

describe("countdown", () => {
  it("lights one lamp a second, holds 0.2–2 s, then goes green", () => {
    const cd = freshCountdown();
    const lit: number[] = [];
    let green = -1;
    for (let i = 0; i < 600 && green < 0; i++) {
      const st = stepCountdown(cd, 1 / 60, () => 0.5);
      lit.push(...st.lit);
      if (st.green) green = i;
    }
    expect(lit).toEqual([0, 1, 2, 3, 4]);
    expect(cd.startHold).toBe(0.2 + 0.5 * 1.8);
    expect((green + 1) / 60).toBeGreaterThan(COUNTDOWN_S + cd.startHold);
    expect((green + 1) / 60).toBeLessThan(COUNTDOWN_S + cd.startHold + 2 / 60);
  });

  it("lights every lamp it skipped and reports a red-flag restart once", () => {
    const cd = freshCountdown(true);
    expect(stepCountdown(cd, 3.5, () => 0).lit).toEqual([0, 1, 2]);
    const st = stepCountdown(cd, 3, () => 0);
    expect(st.lit).toEqual([3, 4]);
    expect(st.green).toBe(true);
    expect(st.restart).toBe(true);
    expect(cd.restartPending).toBe(false);
  });

  it("holds while a networked start is unnamed, then follows the shared instant", () => {
    const cd = freshCountdown();
    expect(stepCountdown(cd, 1, () => 0, null, true).lit).toEqual([]);
    const st = stepCountdown(cd, 0, () => 0, { hold: 1, untilS: 2.5 });
    expect(cd.countT).toBe(3.5);
    expect(st.lit).toEqual([0, 1, 2]);
    expect(cd.startHold).toBe(1);
  });
});

describe("grid", () => {
  const cars = [
    { driverId: "a:0", tier: 1, isPlayer: false }, { driverId: "b:0", tier: 0, isPlayer: false },
    { driverId: "c:0", tier: 2, isPlayer: true }, { driverId: "d:0", tier: 0, isPlayer: false },
  ];
  it("picks the rule from the mode", () => {
    const base = { timeTrial: false, championship: false, seasonQuali: false, champGrid: "champ", raceGrid: "random", networked: false } as const;
    expect(gridRule(base)).toBe("random");
    expect(gridRule({ ...base, networked: true })).toBe("tier");
    expect(gridRule({ ...base, championship: true })).toBe("champ");
    expect(gridRule({ ...base, championship: true, seasonQuali: true })).toBe("quali");
    expect(gridRule({ ...base, timeTrial: true })).toBe("tier");
  });

  it("orders by tier with one jitter draw per car and seats the player at P12 (or last)", () => {
    let draws = 0;
    const order = gridUp(cars, null, cars[2] ?? null, () => (draws++, 0.5));
    expect(draws).toBe(4);
    expect(order.map((c) => c.driverId)).toEqual(["b:0", "d:0", "a:0", "c:0"]);
    expect(order.map((c) => (c as { gridPos?: number }).gridPos)).toEqual([1, 2, 3, 4]);
  });

  it("spends one draw per car on every rule that builds its own order", () => {
    let draws = 0;
    const rnd = (): number => (draws++, 0.3);
    const rank = (a: string, b: string): number => (a < b ? -1 : 1);
    const ctx = { cars, championship: true, pts: { "d:0": 10, "a:0": 4 }, rank, rnd };
    const champ = gridOrderFor(null, { ...ctx, rule: "champ" });
    expect(champ?.map((c) => c.driverId)).toEqual(["a:0", "d:0", "b:0", "c:0"]);
    expect(draws).toBe(4);
    expect(gridOrderFor(null, { ...ctx, rule: "revchamp" })?.map((c) => c.driverId)).toEqual(["d:0", "c:0", "b:0", "a:0"]);
    expect(draws).toBe(8);
    const q = [cars[1], cars[0], cars[3], cars[2]] as typeof cars;
    expect(gridOrderFor(q, { ...ctx, rule: "rev10" })).toEqual([cars[2], cars[3], cars[0], cars[1]]);
    expect(champOrder(cars, rank, () => 0)).toBeNull();
  });
});

describe("endRace sweep", () => {
  it("retires an AI that passed its drawn failure, never a human or a finisher", () => {
    const mk = (o: object) => ({ human: false, finished: false, retired: false, prog: 6000, dnfAt: 0.5, dnfWhy: "engine", dnf: null, tier: 0, team: { id: "t", tier: 0 }, isPlayer: false, driverId: "x", code: "X", ...o });
    const cars = [mk({}), mk({ human: true }), mk({ finished: true }), mk({ prog: 4000 }), mk({ dnfWhy: null, prog: 9000 })];
    sweepPassedFailures(cars, 2, 5000);
    expect(cars.map((c) => c.retired)).toEqual([true, false, false, false, true]);
    expect(cars[4]?.dnf).toBe("mechanical");
  });
});
