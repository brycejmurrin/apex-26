// The lap-wide weather arc replayed against f1-game WeatherArc.create(G):
// stage flips, lagged wetness, re-targets and the seeded MIXED plan.
import { describe, expect, it } from "vitest";
import { arcSeq, drawPlan, startArc, tickArc, wetness, type Wx, type WxArc } from "../../../src/race/weather-arc";
import { fixture, revive } from "./fixture";

interface Run {
  w0: Wx; from: Wx; to: Wx; dur: number; armed: boolean; wetIn: number | null;
  retarget: { to: Wx; dur: number } | null; steps: [Wx, number, number | null][]; announced: string[];
}

describe("weather arc", () => {
  const fx = revive<{ runs: Run[]; plans: { seed: number; round: number; from: Wx; laps: number; len: number; plan: { to: Wx; dur: number } }[]; seqs: { a: Wx; b: Wx; seq: Wx[] }[] }>(fixture("weather-arc"));

  it("walks the stages and the lagged road wetness second by second", () => {
    for (const [k, run] of fx.runs.entries()) {
      let weather: Wx = run.w0, arc: WxArc | null = null, raceT = 0;
      const announced: string[] = [];
      const s = startArc(arc, weather, run.from, run.to, run.dur, raceT, true);
      arc = s.arc; if (s.weather) weather = s.weather;
      expect(!!arc, `run ${k}`).toBe(run.armed);
      expect(arc ? arc.wetIn : null, `run ${k}`).toBe(run.wetIn);
      run.steps.forEach((want, i) => {
        raceT += 1;
        if (i === 120 && run.retarget) {
          const r = startArc(arc, weather, weather, run.retarget.to, run.retarget.dur, raceT, true);
          arc = r.arc; if (r.weather) weather = r.weather;
        }
        const t = tickArc(arc, weather, raceT);
        arc = t.arc; if (t.weather) weather = t.weather;
        if (t.announce) announced.push(t.announce);
        expect([weather, wetness(arc, weather), arc ? arc.wetIn : -1], `run ${k} t ${i}`).toEqual(want);
      });
      expect(announced, `run ${k}`).toEqual(run.announced);
    }
  });

  it("draws the MIXED plan from the seed and caps it for short races", () => {
    for (const p of fx.plans) expect(drawPlan(p.seed, p.round, p.from, p.laps, p.len)).toEqual(p.plan);
  });

  it("walks the ladder stage by stage, laterals direct", () => {
    for (const s of fx.seqs) expect(arcSeq(s.a, s.b)).toEqual(s.seq);
  });
});
