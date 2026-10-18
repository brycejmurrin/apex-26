import { describe, expect, it } from "vitest";
import { dashKph, fmtTime, gearText, spdDigits, spdUnit } from "../../src/hud/readouts";

describe("HUD readouts (game.js fmtTime, hud-readouts.js spdDigits)", () => {
  it("fmtTime rounds before splitting and empties non-positive", () => {
    expect(fmtTime(83.456)).toBe("1:23.46");
    expect(fmtTime(119.9996)).toBe("2:00.00");
    expect(fmtTime(69.9996)).toBe("1:10.00");
    expect(fmtTime(9.5)).toBe("0:09.50");
    for (const v of [0, -1, Number.NaN, Infinity]) expect(fmtTime(v)).toBe("-");
  });

  it("spdDigits clamps, rounds and never shows -0", () => {
    expect(spdDigits(dashKph(80))).toBe(288);
    expect(Object.is(spdDigits(-0.4), 0)).toBe(true);
    expect(spdDigits(5000)).toBe(999);
    expect(spdDigits(Number.NaN)).toBe(0);
    expect(spdDigits(160.9344, "mph")).toBe(100);
    expect(spdUnit("mph")).toBe("MPH");
  });

  it("gearText", () => {
    expect(gearText(0)).toBe("N");
    expect(gearText(-1)).toBe("R");
    expect(gearText(7)).toBe("7");
  });
});

