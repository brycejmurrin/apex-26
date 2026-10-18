import { describe, expect, it } from "vitest";
import * as data from "../../../src/track/scenery/data";
import * as themes from "../../../src/track/scenery/themes";
import { createF1Vm, diffDigests, digest, haveF1 } from "./f1vm";

describe.skipIf(!haveF1)("data + themes vs f1-game", () => {
  const f1 = haveF1 ? createF1Vm() : null;

  it("TrackSceneryData deep-equals the port", () => {
    const ref = f1!.global<Record<string, unknown>>("TrackSceneryData");
    const port = data as unknown as Record<string, unknown>;
    expect(Object.keys(port).sort()).toEqual(Object.keys(ref).sort());
    for (const k of Object.keys(ref)) {
      if (typeof ref[k] === "function") continue;
      expect(digest(port[k]), k).toBe(digest(ref[k]));
    }
  });

  it("resolveCityStyle matches for every circuit's cityStyle and theme", () => {
    const ref = f1!.global<{ resolveCityStyle: (r: unknown, t: unknown) => unknown }>("TrackSceneryData");
    const list = f1!.global<{ LIST: readonly { cityStyle?: unknown; theme?: string }[] }>("Tracks").LIST;
    for (const d of list) {
      for (const raw of [d.cityStyle, { neon: ["mag", "nope"] }, { dayPal: [] }, null]) {
        expect(digest(data.resolveCityStyle(raw as never, d.theme))).toBe(digest(ref.resolveCityStyle(raw, d.theme)));
      }
    }
  });

  it("SceneryThemes.resolve / variant match", () => {
    const ref = f1!.global<{ resolve: (...a: unknown[]) => unknown; variant: (...a: unknown[]) => unknown }>("SceneryThemes");
    for (const name of ["permanent", "street", "desert", "park", "night-event", "nope", undefined]) {
      for (const night of [false, true]) {
        const ov = { palette: { shell: [0.1, 0.2, 0.3] }, budgets: { hero: 7 } };
        expect(digest(themes.resolve(name, ov, { night }))).toBe(digest(ref.resolve(name, ov, { night })));
        expect(digest(themes.resolve(name, undefined, { night }))).toBe(digest(ref.resolve(name, undefined, { night })));
      }
    }
    const ch = ["a", "b", "c", "d", "e"];
    for (let i = 0; i < 40; i++) expect(themes.variant("monza", `m${i}`, i, ch)).toBe(ref.variant("monza", `m${i}`, i, ch));
    expect(themes.variant("x", "y", 0, [])).toBeNull();
  });

  it("a build with both swapped in is identical (monza)", () => {
    const base = f1!.build("monza");
    expect(diffDigests(base, f1!.build("monza"))).toEqual([]);
    const swapped = f1!.build("monza", { TrackSceneryData: data, SceneryThemes: themes });
    expect(diffDigests(base, swapped)).toEqual([]);
    // Negative control: the digest does see a one-ulp colour change.
    const crowd = data.CROWD_DAY.map((c, i) => (i ? c : [c[0], c[1], c[2] + Number.EPSILON]));
    const bumped = f1!.build("monza", { TrackSceneryData: { ...data, CROWD_DAY: crowd } });
    expect(diffDigests(base, bumped)).toContain("propsGeo");
  }, 300_000);
});
