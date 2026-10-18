// The pit lane's strategy-facing rules replayed against f1-game PitLane: the
// window (authored, engine and built-complex), limit, loss, caution estimate,
// box placement, the two-compound rule and the stop cue's gate.
import { describe, expect, it } from "vitest";
import {
  boxThroughFor, compoundDue, entryRunM, estimate, inWindow, laneWidth, limit, lossS, throughM, twoCompoundRule, worthStopping, zoneOf,
  type PitEnv, type PitModel, type PitTrack, type PitZoneDef,
} from "../../../src/race/pit-lane";
import type { StintEntry } from "../../../src/race/sporting-regs";
import { cmp, fixture, revive } from "./fixture";

interface PCar { prog: number; speed: number; retired: boolean; finished: boolean; lap: number; wear: number; team: { id: string } | null; tyre: { tread: number } | null; tyreLog: StintEntry[] }
interface Case {
  total: number; kp: { a: number; f: number; ph: number }; def: { street: boolean; pitZone?: PitZoneDef }; pit: PitModel | null; env: PitEnv;
  flag: number; tread: number; lapsTarget: number; cars: PCar[]; zone: unknown; entryRun: number; probes: [number, boolean, number][];
  limit: number; lossS: number; est: unknown[]; worth: boolean[]; box: number[] | null; applies: boolean; due: boolean[]; laneW: number[];
}

describe("pit lane", () => {
  const raw = fixture<{ cases: unknown[]; teams: string[] }>("pit-lane");
  const fx = revive<{ cases: Case[]; teams: string[] }>(raw);

  it("matches f1-game's window, loss, estimate, box and rules", () => {
    fx.cases.forEach((c, k) => {
      const track: PitTrack = {
        total: c.total, def: c.def, pit: c.pit,
        curvature: (s) => c.kp.a * Math.sin(2 * Math.PI * c.kp.f * s / c.total + c.kp.ph),
      };
      const zone = zoneOf(track);
      const at = `case ${k}`;
      expect(cmp(zone), at).toEqual(cmp(c.zone));
      expect(entryRunM(track), at).toBe(c.entryRun);
      for (const [s, inw, th] of c.probes) {
        expect(inWindow(zone, s, c.total), at).toBe(inw);
        expect(throughM(zone as NonNullable<typeof zone>, s, c.total), at).toBe(th);
      }
      expect(limit(zone, c.env.vTop), at).toBe(c.limit);
      expect(lossS(track, zone, c.env), at).toBe(c.lossS);
      expect(cmp(c.cars.map((car) => estimate(car, c.cars, track, zone, c.env, c.flag))), at).toEqual(cmp((raw.cases[k] as { est: unknown }).est, true));
      expect(c.cars.map((car) => worthStopping(car, { enabled: true, wear: car.wear, tread: c.tread, caution: c.flag })), at).toEqual(c.worth);
      if (c.box && zone) {
        expect(c.cars.map((car) => boxThroughFor(zone, c.total, car.team ? fx.teams.indexOf(car.team.id) : -1, fx.teams.length)), at).toEqual(c.box);
      }
      const applies = twoCompoundRule(c.lapsTarget, c.tread, false);
      expect(applies, at).toBe(c.applies);
      expect(c.cars.map((car) => compoundDue(car, applies, c.lapsTarget)), at).toEqual(c.due);
      expect([0, 3, 5, 7, 9].map(laneWidth), at).toEqual(c.laneW);
    });
  });
});
