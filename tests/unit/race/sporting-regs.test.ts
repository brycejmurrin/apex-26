// SportingRegs replayed against f1-game js/race/sporting-regs.js: the compound
// rule, the caution pass watch and blue flags over a simulated field, false starts.
import { describe, expect, it } from "vitest";
import {
  applyCompoundRule, compoundsRun, createBlueFlagWatch, createPassWatch, jumpStartEarlyThrottle, jumpStartFastLaunch, passPenaltyS,
  BLUE_PEN_S, type RegsCar, type StintEntry,
} from "../../../src/race/sporting-regs";
import { clone, cmp, fixture, pick, revive, rng } from "./fixture";

type Car = RegsCar & { code: string };

describe("sporting regs", () => {
  const fx = fixture<{ comp: unknown[]; pass: { steps: unknown[]; final: number[] }[]; jumps: unknown[]; pens: number[] }>("sporting-regs");

  it("applies the two-compound rule", () => {
    for (const k of fx.comp) {
      const c = revive<{ init: Car[]; o: { applies: boolean; suspended: boolean }; run: unknown; out: number; cars: unknown }>(k);
      const cars = clone(c.init);
      expect(applyCompoundRule(cars, c.o).length).toBe(c.out);
      expect(cmp(clone(cars))).toEqual(cmp((k as { cars: unknown }).cars, true));
      expect(compoundsRun((c.init[0] as Car).tyreLog as StintEntry[])).toEqual(c.run);
    }
  });

  it("watches passes under a caution and blue flags tick for tick", () => {
    fx.pass.forEach((raw, k) => {
      const want = revive<{ t: number; ev: unknown; be: unknown; info: unknown; binfo: unknown }[]>(raw.steps);
      const rr = rng(1400 + k);
      const field: (Car & { finishT?: number })[] = [];
      for (let i = 0; i < 8; i++) field.push({ code: "K" + i, prog: 1000 - i * 30 + rr() * 10, speed: 60, retired: false, finished: false, lap: 1, pitState: "none" });
      (field[0] as Car).prog = 1210 + rr() * 10;
      const p = field[4] as Car;
      const troubledIdx = Math.floor(rr() * 8);
      const win = pick(rr, [5, 3, undefined]);
      const w = createPassWatch<Car>(win, (o) => o === field[troubledIdx] && o.prog > 1500);
      const b = createBlueFlagWatch<Car>((q) => q.prog < 0);
      let level = 0, last = "", j = 0;
      for (let t = 0; t < 1200; t++) {
        if (t % 60 === 0) level = pick(rr, [0, 0, 0, 1, 2, 3]);
        for (const c of field) {
          if (c.retired || c.finished) continue;
          c.prog += (c === p ? 1 + rr() * 0.9 : 0.9 + rr() * 0.7) + (c === field[0] ? 0.3 : 0);
          if (rr() < 0.0005) c.retired = true;
          if (rr() < 0.002) c.pitState = c.pitState === "none" ? "lane" : "none";
          if (t > 1100 && rr() < 0.02) { c.finished = true; c.finishT = t + rr(); }
        }
        const ev = w.tick(p, field, level, 1 / 60);
        const be = b.tick(p, field, { total: 400, vRef: 80, caution: level, race: true }, 1 / 60);
        const row = JSON.stringify([w.info(), b.info()]);
        if (ev || be || row !== last) {
          expect({ t, ev, be, info: w.info(), binfo: b.info() }, `run ${k} t ${t}`).toEqual(want[j++]);
          last = row;
        }
      }
      expect(j, `run ${k}`).toBe(want.length);
      expect(field.map((c) => c.prog)).toEqual(raw.final);
    });
  });

  it("prices a sustained blue-flag hold-up once per spell", () => {
    const p: Car = { code: "P", prog: 100, speed: 60, retired: false, finished: false, lap: 1 };
    const lapper: Car = { code: "L", prog: 100 + 380, speed: 60, retired: false, finished: false, lap: 2 };
    const b = createBlueFlagWatch<Car>();
    const evs: unknown[] = [];
    for (let i = 0; i < 600; i++) { const e = b.tick(p, [p, lapper], { total: 400, vRef: 80, race: true }, 1 / 60); if (e) evs.push(e); }
    expect(evs).toEqual([{ type: "warn", code: "L" }, { type: "penalty", sec: BLUE_PEN_S, code: "L" }]);
  });

  it("detects false starts and prices kept places", () => {
    for (const j of revive<{ th: unknown; auto: boolean; t: number; v: number; vRef: number; early: boolean; fast: boolean }[]>(fx.jumps)) {
      const th = j.th === "NaN" ? NaN : j.th;
      expect(jumpStartEarlyThrottle(th, j.auto)).toBe(j.early);
      expect(jumpStartFastLaunch(j.t, j.v, j.vRef)).toBe(j.fast);
    }
    expect([0, 1, 2, 3, 4].map(passPenaltyS)).toEqual(fx.pens);
  });
});
