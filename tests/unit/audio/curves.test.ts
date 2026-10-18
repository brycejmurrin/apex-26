/**
 * The pure audio curves against f1-game values (tests/fixtures/audio/curves.json,
 * written from f1-game in a Node VM by tools/audio/gen-engine-trace.ts):
 * ErsLayer pitch and gain, tyre squeal, airflow, tone-model naming and clamping.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createEngine } from "../../../src/audio/engine";
import { deployGain, deployHz, harvestGain, harvestHz, sustainGain, type ErsGainOpts } from "../../../src/audio/ers-layer";
import { nameForTune, patchTune, SOUND_PROFILES, TUNE_DEF, type SoundProfile, type Tune } from "../../../src/audio/tone-model";
import { enc } from "./fake-ctx";

interface Curves { ers: unknown[][]; squeal: unknown[][]; wind: unknown[][]; tune: unknown[][] }
const want = JSON.parse(readFileSync(new URL("../../fixtures/audio/curves.json", import.meta.url), "utf8")) as Curves;
const grid = [-0.5, 0, 0.03, 0.1, 0.19, 0.2, 0.37, 0.5, 0.81, 1, 1.4];

describe("audio curves match f1-game", () => {
  it("ErsLayer pitch and gain", () => {
    const got: unknown[][] = [];
    for (const a of grid) for (const b of grid) {
      const optsList: (ErsGainOpts | undefined)[] = [undefined, { speed: b, boostTune: 1.12, partBias: 0.9 }, { layerOn: false }, { ersOn: false, boostTune: 0 }];
      for (const o of optsList) {
        got.push([a, b, o ? {} : null, deployHz(a, b), harvestHz(a), deployGain(a, b, o), harvestGain(a, b, a * 0.1, o), sustainGain(a > 0.3, b, o)].map(enc));
      }
    }
    expect(got).toEqual(want.ers);
  });

  it("tyre squeal and airflow", () => {
    const ga = createEngine({ AudioContext: null });
    const squeal: unknown[][] = [];
    for (const a of grid) for (const b of grid) squeal.push([enc(a), enc(b), ga.squealFromSlip(a, b, false), ga.squealFromSlip(a, b, true)]);
    expect(JSON.parse(JSON.stringify(squeal))).toEqual(want.squeal);
    expect(JSON.parse(JSON.stringify(grid.map((a) => [enc(a), ga.windFromSpeed(a)])))).toEqual(want.wind);
  });

  it("tone-model naming and clamping", () => {
    const profiles: SoundProfile[] = ["team", "broadcast", "trackside", "cockpit", "v10"];
    const got: unknown[][] = [];
    for (const p of profiles) for (const cur of [...profiles, "custom"]) {
      const tune: Tune = Object.assign({}, TUNE_DEF, SOUND_PROFILES[p] || {});
      const patched: Tune = Object.assign({}, tune);
      patchTune(patched, { pitch: 9, idle: -1, curve: NaN, sub: 2.5, bogus: 1 });
      got.push([p, cur, nameForTune(tune, cur), patched, nameForTune(patched, cur)]);
    }
    expect(JSON.parse(JSON.stringify(got))).toEqual(want.tune);
  });
});
