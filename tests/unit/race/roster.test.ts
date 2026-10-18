// The roster against f1-game js/data/teams.js and js/data/driver-ratings.js.
import { describe, expect, it } from "vitest";
import { get, overall, skill, type Axis } from "../../../src/race/roster/ratings";
import { DEFAULT_CUSTOM, POINTS, TEAMS, TIER_V, sanitizeCustom } from "../../../src/race/roster/teams";
import { cmp, fixture, revive } from "./fixture";

describe("roster", () => {
  const raw = fixture<{ ratings: unknown[]; customs: { t: unknown; out: unknown }[]; points: number[]; tierV: number[]; list: unknown; defaultCustom: unknown }>("roster");
  const fx = revive<typeof raw>(raw);

  it("carries the generated grid and the tables unchanged", () => {
    expect(cmp(TEAMS)).toEqual(cmp(raw.list, true));
    expect([...POINTS]).toEqual(fx.points);
    expect([...TIER_V]).toEqual(fx.tierV);
    expect(cmp(DEFAULT_CUSTOM)).toEqual(cmp(raw.defaultCustom, true));
  });

  it("rates every driver, generated codes and career deltas included", () => {
    for (const x of revive<{ code: string; tier: number; deltas: Partial<Record<Axis, unknown>> | null; g: unknown; overall: number; skill: number; roll: number }[]>(raw.ratings)) {
      const g = get(x.code, x.tier, x.deltas);
      expect(g, x.code).toEqual(x.g);
      expect(overall(g)).toBe(x.overall);
      expect(skill(g, x.roll)).toBe(x.skill);
    }
  });

  it("repairs a stored My Team record field by field", () => {
    raw.customs.forEach((c, i) => expect(cmp(sanitizeCustom(revive(c.t))), `custom ${i}`).toEqual(cmp(c.out, true)));
  });
});
