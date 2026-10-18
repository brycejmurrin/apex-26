// newPlayerCar: the sim's one source of player-car defaults (src/sim/player-step-car.ts).
import { describe, expect, it } from "vitest";
import { newPlayerCar } from "../../src/sim/player-step-car";

describe("newPlayerCar", () => {
  it("returns a fresh, unshared car each call", () => {
    const a = newPlayerCar();
    const b = newPlayerCar("P2");
    expect(a).not.toBe(b);
    a.speed = 50;
    expect(b.speed).toBe(0);
    expect(a.code).toBe("YOU");
    expect(b.code).toBe("P2");
  });
  it("is a local human player at rest, unplaced", () => {
    const c = newPlayerCar();
    expect([c.human, c.local, c.isPlayer]).toEqual([true, true, true]);
    expect([c.s, c.x, c.speed, c.lap, c.gear]).toEqual([0, 0, 0, 0, 1]);
    expect(c.collideT).toBe(0);
    expect(c.retired || c.finished).toBe(false);
  });
});
