// The season (src/modes/season.ts) replayed against f1-game SeasonCal over
// scripted sessions: setup changes, flows, restarts, awards (sprints, dropped
// scores, shortened races), saves, loads of damaged saves, presets, luck seeds.
import { describe, expect, it } from "vitest";
import type { WeekendStage } from "../../../src/contracts/race";
import type { ShortRun } from "../../../src/race/race-control";
import { SeasonCal, shuffled, type CalCircuit, type Season } from "../../../src/modes/season";
import { MemoryStorage, SaveStore } from "../../../src/modes/store";
import { clone, fixture, revive } from "./fixture";

type Op = [string, ...unknown[]];
interface Step { op: Op; out: unknown; season: unknown; rank?: string[] }

describe("season calendar and save", () => {
  const fx = revive<{ list: CalCircuit[]; scripts: { ops: Step[]; saved: Record<string, string> }[] }>(fixture("season-cal"));
  const drivers = Array.from({ length: 8 }, (_, i) => ({ driverId: "abcd"[i % 4] + ":" + (i >> 2), code: "D" + i, team: { id: "abcd"[i % 4] as string, tier: 0 } }));

  fx.scripts.forEach((script, k) => {
    it(`script ${k} matches SeasonCal step by step`, () => {
      const storage = new MemoryStorage();
      const store = new SaveStore(storage);
      const S = new SeasonCal(store, { list: fx.list });
      let season: Season | null = null;
      script.ops.forEach((step, i) => {
        const [name, ...a] = step.op;
        let out: unknown = null;
        switch (name) {
          case "setConfig": out = S.setConfig(a[0]); break;
          case "engage": S.engage(a[0] as "season"); break;
          case "restart": season = S.restart(); break;
          case "applyConfig": {
            const res = S.applyConfig(a[0]);
            if (res.season) season = res.season;
            out = { ok: res.ok, reason: res.reason, has: !!res.season };
            break;
          }
          case "award": {
            const byId = new Map(drivers.map((d) => [d.driverId, d]));
            const order = (a[0] as string[]).map((id) => ({ ...byId.get(id)! }));
            out = S.award(season, order, a[1] as string, a[2] as ShortRun | null) as WeekendStage | null;
            break;
          }
          case "probe": out = {
            rounds: S.rounds(), list: S.calendar().map((t) => t.id), stage: S.stage(season), sprintOn: S.sprintOn(season), mid: S.midWeekend(season),
            quali: S.quali(), label: S.qualiLabel(season), lapsFor: S.lapsFor(10, season), roundLaps: S.roundLaps(10, season, 7),
            table: [...S.pointsTable()], draw: S.drawRound(season), canRace: S.canRace(season), progress: S.hasProgress(season), gp: S.gpName(S.track(0)), cfg: S.config(),
          }; break;
          case "save": out = S.save(season); break;
          case "load": season = S.load(); out = { lossy: S.lastLoadLossy() }; break;
          case "loadBad": store.write("season", a[0]); season = S.load(); out = { lossy: S.lastLoadLossy() }; break;
          case "luck": out = S.luckSeed(season, a[0] as number); break;
          case "clear": out = S.clear(); break;
          case "preset": out = S.preset(a[0] as string); break;
          case "shuffle": out = shuffled(fx.list.map((t) => t.id), a[0] as number); break;
        }
        const at = `script ${k} op ${i} ${name}`;
        if (name !== "engage" && name !== "restart") expect(clone(out), at).toEqual(step.out);
        expect(season ? revive(clone(season)) : null, at).toEqual(step.season);
        if (step.rank && season) expect(drivers.map((d) => d.driverId).sort((x, y) => S.rank(season, x, y)), at).toEqual(step.rank);
      });
      for (const key of ["season", "seasonCfg"]) {
        expect(JSON.parse(JSON.stringify(store.get<unknown>(key, null))) ?? null, `script ${k} ${key}`).toEqual(script.saved[key] ?? null);
      }
    });
  });
});
