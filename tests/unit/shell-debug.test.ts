import { describe, expect, it } from "vitest";
import { NEUTRAL_INPUT, completeInput } from "../../src/debug/api";

describe("debug API input completion", () => {
  it("fills missing fields neutral and derives pedal flags/levels", () => {
    expect(completeInput({})).toEqual(NEUTRAL_INPUT);
    expect(completeInput({ throttle: true })).toMatchObject({ throttle: true, throttleLevel: 1 });
    expect(completeInput({ brakeLevel: 0.4 })).toMatchObject({ brake: true, brakeLevel: 0.4 });
    expect(completeInput({ steer: 3 }).steer).toBe(1);
  });
});
