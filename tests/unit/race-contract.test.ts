// Compile-time checks on src/contracts/race.ts: the integrated car is
// `CarState & RaceCar`, so every field the two share must agree on its type.
import { describe, expect, it } from "vitest";
import type { CarState, RaceCar, RaceState } from "../../src/contracts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type Shared = Extract<keyof CarState, keyof RaceCar>;

export type SharedAgree = Expect<Equal<Pick<CarState, Shared>, Pick<RaceCar, Shared>>>;
export type CarsAreRaceCars = Expect<Equal<RaceState["cars"][number], RaceCar>>;
// The arc rule reaches the race store too: no curvature on a race car.
export type NoArc = Expect<Equal<Extract<keyof RaceCar, "curvature" | "kPath" | "racingLineX">, never>>;

describe("race contract", () => {
  it("shares the timing fields with CarState", () => {
    const shared: Shared[] = ["s", "prog", "lap", "lapTime", "best", "speed", "retired", "finished", "human", "isPlayer"];
    expect(shared.length).toBe(10);
  });
});
