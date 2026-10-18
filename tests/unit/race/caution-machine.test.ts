// The caution machine replayed against f1-game RaceControl.create(G): 2,400
// ticks per run of scripted hazards, holds, host applies, storms, CAUTIONS
// toggles, red-flag restarts and phase changes (tools/race-fixtures/gen.cjs).
import { describe, expect, it } from "vitest";
import type { Caution, HazardPicture, RacePhase } from "../../../src/contracts/race";
import {
  applyCaution, cautionInfo, clearCapHold, createRaceControl, holdCaution, otDetectOpen, otEnabled, rewound,
  setCautionsEnabled, takeRestart, updateRaceControl, type RaceControlCtx,
} from "../../../src/race/race-control";
import { cmp, fixture, revive } from "./fixture";

type Ev = [string, ...unknown[]];
interface Row { ot: boolean; otDetect: boolean; pub: number; ann: number }
// Compact: `info`/`row` appear only when they changed since the previous tick.
interface Step { ev?: Ev[]; hz?: HazardPicture; out?: Record<string, unknown>; info?: unknown; row?: Row }
interface Run { net: boolean; steps: Step[]; published: unknown[]; announced: string[] }

describe("caution machine", () => {
  const runs = fixture<Run[]>("caution-machine");

  runs.forEach((raw, n) => {
    it(`run ${n} (net=${raw.net}) matches f1-game tick for tick`, () => {
      const run = revive<Run>(raw);
      const st = createRaceControl(true);
      let hz: HazardPicture = { total: 0, redTotal: null, sectors: [0, 0, 0], worst: { count: 0, sector: -1, frac: 0 } };
      let storm = false, lowGrip = false, debris = true, phase: RacePhase = "race", raceT = 0;
      const leader = { lap: 1 };
      const published: Caution[] = [], announced: string[] = [];
      const ctx = (): RaceControlCtx => ({
        phase, timeTrial: false, quali: false, ranked: [leader], raceT,
        netActive: run.net, ownsRaceControl: true,
        reportCaution: (c) => published.push({ ...c }),
        debrisActive: () => debris, hazards: () => hz, storm, lowGrip,
        announce: (t) => { announced.push(t); return true; },
      });
      let info: unknown = null, row: Row | null = null;
      run.steps.forEach((step, i) => {
        if (step.hz) hz = step.hz;
        if (step.info) info = step.info;
        if (step.row) row = step.row;
        const out: Record<string, unknown> = {};
        for (const e of step.ev ?? []) {
          const c = ctx();
          switch (e[0]) {
            case "hold": out["hold"] = holdCaution(st, c, e[1] as number, e[2] as string); break;
            case "enable": out["enable"] = setCautionsEnabled(st, e[1] as boolean); break;
            case "apply": out["apply"] = applyCaution(st, c, e[1]); break;
            case "takeRestart": out["takeRestart"] = takeRestart(st); break;
            case "clearHold": clearCapHold(st); break;
            case "rewound": rewound(st); break;
            case "storm": storm = e[1] as boolean; break;
            case "lowGrip": lowGrip = e[1] as boolean; break;
            case "debris": debris = e[1] as boolean; break;
            case "phase": phase = e[1] as RacePhase; break;
            case "lap": leader.lap++; break;
          }
        }
        raceT += 1 / 60;
        updateRaceControl(st, ctx(), 1 / 60);
        const where = `run ${n} tick ${i}`;
        expect(out, where).toEqual(step.out ?? {});
        expect(cmp(cautionInfo(st, lowGrip)), where).toEqual(cmp(info));
        expect({ ot: otEnabled(st, [leader], lowGrip), otDetect: otDetectOpen(st, lowGrip), pub: published.length, ann: announced.length }, where)
          .toEqual(row);
      });
      expect(cmp(published)).toEqual(cmp(run.published));
      expect(announced).toEqual(run.announced);
    });
  });
});
