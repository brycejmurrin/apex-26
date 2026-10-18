// @vitest-environment happy-dom
// The Data Hub's STANDINGS tab. Ported from f1-game
// tests/unit/data-standings.test.mjs: row order is the API's order, the gap is
// to the P1 row, the leader row is marked, a team's two drivers get a
// head-to-head bar, a near-black team colour falls back to its second colour,
// and an empty (or null) response reads as the empty-state message.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConstructorStanding, DriverStanding, F1Api } from "../../../src/data/api";
import { setDataLog } from "../../../src/data/log";
import { create, mount } from "../../../src/data/tabs/standings";
import type { Team } from "../../../src/data/teams";
import { stubDeps } from "./hub-stub";

// Two teams the way the hub's findTeam resolves them: by a substring of the
// API's constructor name. BLACK is near-black with a light second colour.
const TEAMS: Record<string, Team> = {
  mclaren: { short: "MCL", color: [1, 0.5, 0] } as Team,
  black: { short: "BLK", color: [0.02, 0.02, 0.02], color2: [0.9, 0.9, 0.9] } as Team,
};
const findTeam = (name: string | null | undefined): Team | null => {
  if (!name) return null;
  const n = String(name).toLowerCase();
  return Object.keys(TEAMS).filter((k) => n.includes(k)).map((k) => TEAMS[k]!)[0] || null;
};

type Drivers = DriverStanding[] | null;
type Cons = ConstructorStanding[] | null;
function boot(drivers: Drivers, cons: Cons, apiOver: Partial<F1Api> | null = null) {
  const base = stubDeps([], { findTeam });
  const api: F1Api = { ...base.api, ...(apiOver || {
    driverStandings: () => Promise.resolve(drivers as DriverStanding[]),
    constructorStandings: () => Promise.resolve(cons as ConstructorStanding[]),
  }) };
  return create({ ...base, api });
}

const cols = (wrap: HTMLElement) => [...wrap.children].filter((c) => c.classList.contains("dh-standings-col")) as HTMLElement[];
const rowsIn = (col: HTMLElement) => [...col.children].filter((c) => c.classList.contains("dh-row")) as HTMLElement[];
const textOf = (row: Element, cls: string) => row.querySelector("." + cls)?.textContent ?? null;

const d = (pos: number, points: number, wins: number, name: string | null, code: string | null, team: string): DriverStanding =>
  ({ pos, points, wins, name, code, team, number: null });
const DRIVERS: DriverStanding[] = [
  d(1, 120, 3, "Lando Norris", "NOR", "McLaren"),
  d(2, 101, 1, "Oscar Piastri", "PIA", "McLaren"),
  d(3, 88, 0, "Test Driver", "TST", "Black Racing"),
  d(4, 40, 0, null, null, "Black Racing"),
];
const CONS: ConstructorStanding[] = [
  { pos: 1, points: 221, wins: 4, name: "McLaren" },
  { pos: 2, points: 128, wins: 0, name: "Black Racing" },
];

describe("standings tab (f1-game data-standings.test.mjs)", () => {
  it("driver and constructor rows keep the API's order, gaps read to P1, and the leader row is marked", async () => {
    const wrap = await boot(DRIVERS, CONS).loadStandings();
    expect(wrap.classList.contains("dh-standings")).toBe(true);
    const [dcol, ccol] = cols(wrap) as [HTMLElement, HTMLElement];
    expect(textOf(dcol, "dh-section")).toBe("DRIVERS");
    expect(textOf(ccol, "dh-section")).toBe("CONSTRUCTORS");

    const drows = rowsIn(dcol);
    expect(drows.map((r) => textOf(r, "dh-pos"))).toEqual(["1", "2", "3", "4"]);
    expect(drows.map((r) => textOf(r, "dh-codechip"))).toEqual(["NOR", "PIA", "TST", "—"]);
    // a nameless entry reads — rather than throwing
    expect(drows.map((r) => textOf(r, "dh-name"))).toEqual(["Lando Norris", "Oscar Piastri", "Test Driver", "—"]);
    expect(drows.map((r) => textOf(r, "dh-pts"))).toEqual(["120", "101", "88", "40"]);
    expect(drows.map((r) => textOf(r, "dh-gap"))).toEqual([null, "−19", "−32", "−80"]);
    expect(drows.map((r) => textOf(r, "dh-wins"))).toEqual(["3W", "1W", null, null]);
    expect(drows.map((r) => r.classList.contains("dh-row-lead"))).toEqual([true, false, false, false]);

    const crows = rowsIn(ccol);
    expect(crows.map((r) => textOf(r, "dh-name"))).toEqual(["McLaren", "Black Racing"]);
    expect(crows.map((r) => textOf(r, "dh-codechip"))).toEqual(["MCL", "BLK"]);   // the resolved team's short name
    expect(crows.map((r) => textOf(r, "dh-gap"))).toEqual([null, "−93"]);
    expect(crows.every((r) => r.classList.contains("dh-row-cons"))).toBe(true);
  });

  it("team colour: --row-team from findTeam, a near-black team falls back to color2", async () => {
    const wrap = await boot(DRIVERS, CONS).loadStandings();
    const drows = rowsIn(cols(wrap)[0]!);
    expect(drows[0]!.style.getPropertyValue("--row-team")).toBe("rgb(255,128,0)");
    expect(drows[2]!.style.getPropertyValue("--row-team")).toBe("rgb(230,230,230)");   // near-black uses color2
    const lone = await boot([d(1, 5, 0, "X", "XXX", "Nobody")], []).loadStandings();
    expect(rowsIn(cols(lone)[0]!)[0]!.style.getPropertyValue("--row-team")).toBe("");   // unknown team: no colour
  });

  it("a team with two drivers gets a head-to-head bar ordered by points", async () => {
    // Hand the drivers in reverse points order: the bar must still put the leader first.
    const wrap = await boot([...DRIVERS].reverse(), CONS).loadStandings();
    const crows = rowsIn(cols(wrap)[1]!);
    const labels = (row: HTMLElement) => [...row.querySelector(".dh-h2h-labels")!.children].map((c) => c.textContent);
    expect(labels(crows[0]!)).toEqual(["NOR", "PIA"]);
    expect(labels(crows[1]!)).toEqual(["TST", "—"]);   // a nameless, codeless driver abbreviates to —
    const fills = [...crows[0]!.querySelectorAll<HTMLElement>(".dh-h2h-fill")].map((f) => f.style.width);
    expect(fills.length).toBe(2);
    expect(Math.abs(parseFloat(fills[0]!) - 120 / 221 * 100)).toBeLessThan(1e-9);
  });

  it("empty standings read as the empty-state messages, not a blank tab", async () => {
    for (const [dr, c] of [[[], []], [null, null]] as [Drivers, Cons][]) {
      const wrap = await boot(dr, c).loadStandings();
      const [dcol, ccol] = cols(wrap) as [HTMLElement, HTMLElement];
      expect(rowsIn(dcol).length).toBe(0);
      expect(textOf(dcol, "dh-empty")).toBe("No driver standings yet — season hasn't started.");
      expect(textOf(ccol, "dh-empty")).toBe("No constructor standings yet.");
    }
    // Drivers published before constructors: each column decides on its own.
    const half = await boot(DRIVERS.slice(0, 1), []).loadStandings();
    expect(rowsIn(cols(half)[0]!).length).toBe(1);
    expect(textOf(cols(half)[1]!, "dh-empty")).toBe("No constructor standings yet.");
  });

  // review-race-career-data #17: api reads the year off the clock, so from
  // January to the opener the tab said "season hasn't started" for ten weeks.
  it("an empty current year falls back to last season's FINAL table, labelled as such", async () => {
    const asked: unknown[] = [];
    const byYear = <T>(table: T[]) => (year?: number | string | null) => { asked.push(year); return Promise.resolve(year === 2026 ? table : []); };
    const wrap = await boot(null, null, { season: () => "2027", driverStandings: byYear(DRIVERS), constructorStandings: byYear(CONS) }).loadStandings();
    const [dcol, ccol] = cols(wrap) as [HTMLElement, HTMLElement];
    expect(asked).toEqual([undefined, undefined, 2026, 2026]);   // current year first, then the one before
    expect(rowsIn(dcol).length).toBe(4);
    expect(rowsIn(ccol).length).toBe(2);
    expect(textOf(dcol, "dh-section")).toBe("DRIVERS — LAST SEASON · 2026 FINAL");
    expect(textOf(ccol, "dh-section")).toBe("CONSTRUCTORS — LAST SEASON · 2026 FINAL");

    // A current table, however short, is never replaced; its headings stay plain.
    asked.length = 0;
    const cur = await boot(null, null, {
      season: () => "2026",
      driverStandings: (y) => { asked.push(y); return Promise.resolve(DRIVERS.slice(0, 1)); },
      constructorStandings: () => Promise.resolve([]),
    }).loadStandings();
    expect(asked).toEqual([undefined]);
    expect(textOf(cols(cur)[0]!, "dh-section")).toBe("DRIVERS");

    // Both years empty, or the fallback fetch failing: the empty-state messages, unlabelled.
    for (const prev of [() => Promise.resolve([]), () => Promise.reject(new Error("offline"))]) {
      const w = await boot(null, null, {
        season: () => "2027",
        driverStandings: (y) => (y == null ? Promise.resolve([]) : prev()),
        constructorStandings: (y) => (y == null ? Promise.resolve([]) : prev()),
      }).loadStandings();
      expect(textOf(cols(w)[0]!, "dh-section")).toBe("DRIVERS");
      expect(textOf(cols(w)[0]!, "dh-empty")).toBe("No driver standings yet — season hasn't started.");
    }
  });

  it("a rival tied on points with the leader shows no gap, not \"−0\"", async () => {
    const tied = [d(1, 120, 3, "Lando Norris", "NOR", "McLaren"), d(2, 120, 1, "Oscar Piastri", "PIA", "McLaren"),
      d(3, 118, 0, "Test Driver", "TST", "Black Racing")];
    const wrap = await boot(tied, [
      { pos: 1, points: 221, wins: 4, name: "McLaren" }, { pos: 2, points: 221, wins: 0, name: "Black Racing" },
    ]).loadStandings();
    const [dcol, ccol] = cols(wrap) as [HTMLElement, HTMLElement];
    expect(rowsIn(dcol).map((r) => textOf(r, "dh-gap"))).toEqual([null, null, "−2"]);
    expect(rowsIn(ccol).map((r) => textOf(r, "dh-gap"))).toEqual([null, null]);
  });
});

const ROUTES: [string, string][] = [
  ["/2025/driverstandings.json", "jolpica-2025-driverstandings.json"],
  ["/2025/constructorstandings.json", "jolpica-2025-constructorstandings.json"],
];

describe("standings tab mounted against recorded Jolpica 2025 fixtures", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    setDataLog({ info: () => {}, warn: () => {} });
  });
  afterEach(() => { vi.useRealTimers(); });

  async function mounted(now: string) {
    vi.setSystemTime(new Date(now));
    const host = document.createElement("div");
    const m = mount(host, stubDeps(ROUTES));
    expect(host.querySelector(".dh-loading")).toBeTruthy();
    await vi.runAllTimersAsync();
    await vi.waitFor(() => expect(host.querySelector(".dh-standings")).toBeTruthy());
    return { host, m };
  }

  it("in 2025 the table is this season's: NOR leads, McLaren tops the constructors", async () => {
    const { host, m } = await mounted("2025-12-20T12:00:00Z");
    const [dcol, ccol] = cols(host.firstElementChild as HTMLElement) as [HTMLElement, HTMLElement];
    expect(textOf(dcol, "dh-section")).toBe("DRIVERS");
    const drows = rowsIn(dcol);
    expect(drows.length).toBeGreaterThan(19);
    expect(textOf(drows[0]!, "dh-codechip")).toBe("NOR");
    expect(drows[0]!.classList.contains("dh-row-lead")).toBe(true);
    expect(textOf(drows[1]!, "dh-gap")).toBe("−2");   // VER 421 vs NOR 423
    const crows = rowsIn(ccol);
    expect(textOf(crows[0]!, "dh-name")).toBe("McLaren");
    expect(crows[0]!.querySelector(".dh-h2h-wrap")).toBeTruthy();
    expect(crows[0]!.style.getPropertyValue("--row-team")).not.toBe("");
    m.unmount();
    expect(host.childNodes.length).toBe(0);
  });

  it("in 2026 with no 2026 table yet (404) it falls back to the labelled 2025 FINAL", async () => {
    const { host, m } = await mounted("2026-01-15T12:00:00Z");
    const [dcol, ccol] = cols(host.firstElementChild as HTMLElement) as [HTMLElement, HTMLElement];
    expect(textOf(dcol, "dh-section")).toBe("DRIVERS — LAST SEASON · 2025 FINAL");
    expect(textOf(ccol, "dh-section")).toBe("CONSTRUCTORS — LAST SEASON · 2025 FINAL");
    expect(rowsIn(dcol).length).toBeGreaterThan(19);
    m.unmount();
  });
});
