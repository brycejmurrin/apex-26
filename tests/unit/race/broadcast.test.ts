// Broadcast's pure half replayed against f1-game js/race/broadcast.js: the timing
// tower over seeded race scripts, gap text, battles, PiP pick, next event, shots.
import { describe, expect, it } from "vitest";
import {
  SHOTS, battles, fmtGap, nextEvent, pipPick, shotFor, towerAt, towerSample,
  type DirectorCar, type Fight, type RaceEvent, type RaceScript,
} from "../../../src/race/broadcast";
import { clone, cmp, fixture, revive } from "./fixture";

describe("broadcast", () => {
  const raw = fixture<{ towers: { script: unknown; samples: unknown[] }[]; director: unknown[]; SHOTS: string[] }>("broadcast");

  it("builds the timing tower and its sample key like f1-game", () => {
    for (const [k, t] of raw.towers.entries()) {
      const script = revive<RaceScript>(t.script);
      for (const s of revive<{ T: number; out: number[] | null; key: number; rows: unknown; gaps: [string, string][] }[]>(t.samples)) {
        const out = s.out ? (num: number) => (s.out as number[]).includes(num) : undefined;
        const rows = towerAt(script, s.T, out);
        expect(cmp(clone(rows)), `tower ${k} T ${s.T}`).toEqual(cmp(s.rows));
        expect(towerSample(script, s.T, out)).toBe(s.key);
        expect(rows.map((x) => [fmtGap(x, "gap"), fmtGap(x, "interval")])).toEqual(s.gaps);
      }
    }
  });

  it("picks battles, the PiP car, the next event and the shot like f1-game", () => {
    for (const [k, d] of revive<{
      cars: DirectorCar<string>[]; vScale: number | null; fights: Fight<string>[]; follow: string; evKey: string | null; evKind: string | null;
      running: { key: string }[] | null; pip: unknown; events: RaceEvent[]; shown: number[]; T: number; lead: number; ok: number[] | null; next: unknown;
      shots: { kind: string | null; onAir: string | null; n: number; shot: string | null }[];
    }[]>(raw.director).entries()) {
      const at = `case ${k}`;
      const fights = battles(d.cars, d.vScale ?? undefined);
      expect(clone(fights), at).toEqual(d.fights);
      expect(pipPick(fights, d.follow, d.evKey, d.evKind, d.running), at).toEqual(d.pip);
      const ok = d.ok ? (num: number) => (d.ok as number[]).includes(num) : undefined;
      expect(nextEvent(d.events, d.T, new Set(d.shown), d.lead, ok), at).toEqual(d.next);
      for (const s of d.shots) expect(shotFor(s.kind, s.onAir, s.n), at).toBe(s.shot);
    }
    expect([...SHOTS]).toEqual(raw.SHOTS);
  });
});
