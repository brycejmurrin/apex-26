// @vitest-environment happy-dom
// The RESULTS tab renders a session, not a race. Ported from f1-game
// tests/unit/data-results.test.mjs (its real-race-tab.js cases belong to that
// module's port, not this one). OpenF1's session_result changes SHAPE with the
// session — `duration` and `gap_to_leader` are scalars for practice, sprint
// and race and [Q1,Q2,Q3] arrays for qualifying — so this drives the real
// render path with each shape and reads the cells back out.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Duration, F1Api, Session, SessionDriver, SessionResultRow } from "../../../src/data/api";
import type { HubDeps } from "../../../src/data/hub-deps";
import { setDataLog } from "../../../src/data/log";
import {
  create, deepest, fmtClock, fmtGap, kindOf, mount, qLabel, roundsRan, type ResultsNode,
} from "../../../src/data/tabs/results";
import { stubDeps } from "./hub-stub";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function meta(m: Partial<Session> & { sessionKey: number }): Session {
  return { meetingKey: null, year: null, name: null, type: null, circuit: null, country: null, dateStart: null, ...m };
}
function row(pos: number | null, num: number, laps: number, points: number | null, duration: Duration, gap: Duration,
             flags: Partial<Pick<SessionResultRow, "dnf" | "dns" | "dsq">> = {}): SessionResultRow {
  return { pos, num, laps, points, dnf: false, dns: false, dsq: false, duration, gap, ...flags };
}
const drv = (num: number, code: string, name: string, team: string): SessionDriver => ({ num, code, name, team, color: null });

// Cut bands (one full-width cell) are EXCLUDED here and asserted by cuts().
function rows(tree: HTMLElement): (string | null)[][] {
  return [...tree.querySelectorAll("tr")]
    .filter((tr) => tr.querySelector("td") && !tr.classList.contains("dh-cut"))
    .map((tr) => [...tr.children].map((td) => (td.children.length
      ? [...td.children].map((c) => c.textContent).filter(Boolean).join(" ")
      : td.textContent)));
}
// Each band's text plus the position of the row directly above it.
function cuts(tree: HTMLElement): [string | null, string | null][] {
  const trs = [...tree.querySelectorAll("tr")].filter((tr) => tr.querySelector("td"));
  const out: [string | null, string | null][] = [];
  trs.forEach((tr, i) => {
    if (!tr.classList.contains("dh-cut")) return;
    const above = trs[i - 1];
    out.push([above ? above.children[0]!.textContent : null, tr.children[0]!.textContent]);
  });
  return out;
}
const pills = (tree: HTMLElement) => [...tree.querySelectorAll(".dh-pill")].map((b) => b.textContent);
function clickPill(tree: HTMLElement, label: string): void {
  const b = [...tree.querySelectorAll<HTMLButtonElement>(".dh-pill")].find((n) => n.textContent === label);
  expect(b, `no pill labelled ${label}`).toBeTruthy();
  b!.click();
}
function headers(tree: HTMLElement): (string | null)[] {
  return [...tree.querySelectorAll("thead th")].map((th) => th.textContent);
}

const DRIVERS = [drv(63, "RUS", "George Russell", "Mercedes"), drv(16, "LEC", "Charles Leclerc", "Ferrari"), drv(1, "NOR", "Lando Norris", "McLaren")];

function deps(m: Session, apiOver: Partial<F1Api>, over: Partial<HubDeps> = {}) {
  const base = stubDeps([]);
  const d = stubDeps([], {
    api: { ...base.api, ...apiOver },
    sel: { year: null, meetingKey: null, sessionKey: m.sessionKey, meta: m, selAt: 0, pinned: true },
    ensureSession: () => Promise.resolve(m),
    fmtDateTime: (iso) => iso ?? "",
    teamChip: (code) => base.el("span", "dh-codechip", code),
    NO_RESULT_MSG: "NOTHING YET",
    ...over,
  });
  return d;
}

async function render(m: Session, results: SessionResultRow[] | null, drivers: SessionDriver[] = DRIVERS,
                      extraApi: Partial<F1Api> = {}, over: Partial<HubDeps> = {}): Promise<ResultsNode> {
  const { loadResults } = create(deps(m, {
    sessionResult: () => Promise.resolve(results as SessionResultRow[]),
    sessionDrivers: () => Promise.resolve(drivers),
    ...extraApi,
  }, over));
  const tree = await loadResults();
  // renderBody's fetch settles a microtask later than loadResults resolves.
  await flush();
  return tree;
}

beforeEach(() => { setDataLog({ info: () => {}, warn: () => {} }); });

describe("results pure helpers", () => {
  it("kindOf reads name and type together; qLabel names sprint rounds SQ", () => {
    expect(kindOf({ name: "Sprint", type: "Race" })).toBe("race");
    expect(kindOf({ name: "Sprint Qualifying", type: "Qualifying" })).toBe("qualifying");
    expect(kindOf({ name: "Practice 2", type: "Practice" })).toBe("practice");
    expect(kindOf(null)).toBe("race");
    expect(qLabel({ name: "Sprint Shootout", type: "Qualifying" }, 1)).toBe("SQ2");
    expect(qLabel({ name: "Qualifying", type: "Qualifying" }, 2)).toBe("Q3");
  });
  it("fmtGap / fmtClock / deepest / roundsRan", () => {
    expect(fmtGap("+1 LAP")).toBe("+1 LAP");
    expect(fmtGap(0)).toBe("—");
    expect(fmtGap(0.12)).toBe("+0.120");
    expect(fmtGap(null)).toBe(null);
    expect(fmtClock(3599.9996)).toBe("1:00:00.000");   // rounds before it splits, never "59:60.000"
    expect(fmtClock(0)).toBe(null);
    expect(deepest({ duration: [70, 69, null], gap: null })).toBe(1);
    expect(deepest({ duration: [null, null, null], gap: null })).toBe(-1);
    expect(roundsRan([{ duration: [70, null, null], gap: null }, { duration: [71, 70, null], gap: null }])).toEqual([0, 1]);
  });
});

describe("results tab (f1-game data-results.test.mjs)", () => {
  it("a practice session classifies on best lap, with no points column", async () => {
    const tree = await render(
      meta({ sessionKey: 11355, name: "Practice 2", type: "Practice", circuit: "Monza", country: "Italy", dateStart: "2026-09-04T14:00:00+00:00" }),
      [row(1, 63, 31, null, 82.559, 0), row(2, 16, 29, null, 82.679, 0.12)],
    );
    expect(headers(tree)).toEqual(["POS", "DRIVER", "TEAM", "LAPS", "BEST", "GAP"]);
    const r = rows(tree);
    expect(r[0]).toEqual(["1", "RUS George Russell", "Mercedes", "31", "1:22.559", "—"]);
    expect(r[1]).toEqual(["2", "LEC Charles Leclerc", "Ferrari", "29", "1:22.679", "+0.120"]);
  });

  it("qualifying spreads the [Q1,Q2,Q3] array across three columns", async () => {
    const tree = await render(meta({ sessionKey: 11349, name: "Qualifying", type: "Qualifying" }), [
      row(1, 1, 21, null, [72.695, 71.628, 71.163], [0.085, 0, 0]),
      row(2, 16, 14, null, [73.4, null, null], [0.7, null, null]),
    ]);
    expect(headers(tree)).toEqual(["POS", "DRIVER", "TEAM", "Q1", "Q2", "Q3"]);
    const r = rows(tree);
    expect(r[0]!.slice(3)).toEqual(["1:12.695", "1:11.628", "1:11.163"]);
    // Knocked out in Q1: the empty slots read as dashes, not as "0.000".
    expect(r[1]!.slice(3)).toEqual(["1:13.400", "—", "—"]);
  });

  // The real Zandvoort 2026 qualifying, trimmed to eight cars: Q1's order is
  // NOT the classification's order, the per-round gap is to THAT round's
  // leader, and the field thinned 8 -> 6 -> 5 rather than by any fixed count.
  const ZANDVOORT = [
    row(1, 1, 21, null, [72.695, 71.628, 71.163], [0.085, 0.0, 0.0]),
    row(2, 63, 20, null, [72.924, 71.959, 71.265], [0.314, 0.331, 0.102]),
    row(3, 12, 21, null, [73.022, 71.915, 71.296], [0.412, 0.287, 0.133]),
    row(4, 81, 19, null, [72.610, 71.641, 71.305], [0.0, 0.013, 0.142]),
    row(5, 44, 18, null, [72.673, 71.970, 71.494], [0.063, 0.342, 0.331]),
    row(6, 10, 17, null, [73.115, 72.616, null], [0.505, 0.988, null]),
    row(7, 55, 16, null, [73.574, null, null], [0.964, null, null]),
    row(8, 77, 15, null, [74.371, null, null], [1.761, null, null]),
  ];
  const Z_DRIVERS = [
    drv(1, "VER", "Max Verstappen", "Red Bull Racing"), drv(63, "RUS", "George Russell", "Mercedes"),
    drv(12, "ANT", "Kimi Antonelli", "Mercedes"), drv(81, "PIA", "Oscar Piastri", "McLaren"),
    drv(44, "HAM", "Lewis Hamilton", "Ferrari"), drv(10, "GAS", "Pierre Gasly", "Alpine"),
    drv(55, "SAI", "Carlos Sainz", "Williams"), drv(77, "BOT", "Valtteri Bottas", "Cadillac"),
  ];
  const QUALI_META = meta({ sessionKey: 11349, name: "Qualifying", type: "Qualifying" });

  it("the overall qualifying table bands the field where each cut fell", async () => {
    const tree = await render(QUALI_META, ZANDVOORT, Z_DRIVERS);
    expect(pills(tree)).toEqual(["OVERALL", "Q1", "Q2", "Q3"]);
    expect(cuts(tree)).toEqual([["5", "ELIMINATED IN Q2 · P6 MAY HAVE ADVANCED WITHOUT A TIME"],
                                ["6", "ELIMINATED IN Q1 · P7 MAY HAVE ADVANCED WITHOUT A TIME"]]);
  });

  it("a round view re-sorts on THAT round's time, not the classification", async () => {
    const tree = await render(QUALI_META, ZANDVOORT, Z_DRIVERS);
    clickPill(tree, "Q1");
    expect(headers(tree)).toEqual(["POS", "DRIVER", "TEAM", "Q1", "GAP"]);
    const r = rows(tree);
    expect(r.map((x) => x[1])).toEqual([
      "PIA Oscar Piastri", "HAM Lewis Hamilton", "VER Max Verstappen", "RUS George Russell",
      "ANT Kimi Antonelli", "GAS Pierre Gasly", "SAI Carlos Sainz", "BOT Valtteri Bottas",
    ]);
    // Gap is to THIS round's leader, so the pole-sitter reads +0.085 here.
    expect(r[0]!.slice(3)).toEqual(["1:12.610", "—"]);
    expect(r[2]!.slice(3)).toEqual(["1:12.695", "+0.085"]);
    expect(cuts(tree)).toEqual([["6", "ELIMINATED IN Q1 · SAI MAY HAVE ADVANCED WITHOUT A TIME"]]);
    expect(tree.querySelector(".dh-pill.active")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("a round view lists only the cars that ran that round", async () => {
    const tree = await render(QUALI_META, ZANDVOORT, Z_DRIVERS);
    clickPill(tree, "Q2");
    const r = rows(tree);
    expect(r.length).toBe(6);   // the two knocked out in Q1 are not in Q2
    expect(r.map((x) => x[1])).toEqual([
      "VER Max Verstappen", "PIA Oscar Piastri", "ANT Kimi Antonelli",
      "RUS George Russell", "HAM Lewis Hamilton", "GAS Pierre Gasly",
    ]);
    expect(cuts(tree)).toEqual([["5", "ELIMINATED IN Q2 · GAS MAY HAVE ADVANCED WITHOUT A TIME"]]);
  });

  it("the final round has no cut band and can be left again", async () => {
    const tree = await render(QUALI_META, ZANDVOORT, Z_DRIVERS);
    clickPill(tree, "Q3");
    expect(rows(tree).length).toBe(5);
    expect(cuts(tree)).toEqual([]);   // nobody is eliminated in the last round
    clickPill(tree, "OVERALL");
    expect(headers(tree)).toEqual(["POS", "DRIVER", "TEAM", "Q1", "Q2", "Q3"]);
    expect(rows(tree).length).toBe(8);
  });

  it("only the rounds that ran get a pill", async () => {
    const tree = await render(QUALI_META, ZANDVOORT.map((r) => {
      const dur = r.duration as (number | null)[], gap = r.gap as (number | null)[];
      return { ...r, duration: [dur[0]!, dur[1]!, null], gap: [gap[0]!, gap[1]!, null] };
    }), Z_DRIVERS);
    expect(pills(tree)).toEqual(["OVERALL", "Q1", "Q2"]);
  });

  it("a race shows points and formats the winner's distance as a clock", async () => {
    const tree = await render(meta({ sessionKey: 11353, name: "Race", type: "Race" }),
      [row(1, 1, 72, 25, 7484.859, 0), row(2, 16, 72, 18, 7496.395, 11.536)]);
    expect(headers(tree)).toEqual(["POS", "DRIVER", "TEAM", "LAPS", "TIME", "GAP", "PTS"]);
    const r = rows(tree);
    expect(r[0]![4]).toBe("2:04:44.859");
    expect(r[0]!.slice(5)).toEqual(["—", "25"]);
    expect(r[1]!.slice(4)).toEqual(["2:04:56.395", "+11.536", "18"]);
    expect(tree.querySelector("tbody tr")!.classList.contains("dh-lr-p1")).toBe(true);
  });

  it("a lapped finisher shows its +1 LAP label in the GAP column", async () => {
    const tree = await render(meta({ sessionKey: 9590, name: "Race", type: "Race" }), [
      row(1, 1, 53, 25, 4480.727, 0),
      row(14, 63, 52, 0, null, "+1 LAP"),
      row(null, 16, 40, 0, null, "+13 LAPS", { dnf: true }),
    ]);
    const r = rows(tree);
    expect(r[1]!.slice(4, 6)).toEqual(["—", "+1 LAP"]);
    expect(r[2]!.slice(4, 6)).toEqual(["DNF", "—"]);   // a retirement keeps an empty gap
  });

  it("a sprint keeps the points column", async () => {
    const tree = await render(meta({ sessionKey: 11348, name: "Sprint", type: "Race" }), [row(1, 63, 24, 8, 1825.318, 0)]);
    expect(headers(tree)).toEqual(["POS", "DRIVER", "TEAM", "LAPS", "TIME", "GAP", "PTS"]);
    expect(rows(tree)[0]![4]).toBe("30:25.318");   // under the hour: no leading "0:"
  });

  it("sprint qualifying is a qualifying, and its rounds are named SQ", async () => {
    const tree = await render(meta({ sessionKey: 11344, name: "Sprint Qualifying", type: "Qualifying" }), [
      row(1, 1, 9, null, [70.1, 69.9, 69.5], [0, 0, 0]),
      row(2, 63, 8, null, [70.4, 70.2, null], [0.3, 0.3, null]),
    ]);
    expect(headers(tree)).toEqual(["POS", "DRIVER", "TEAM", "SQ1", "SQ2", "SQ3"]);
    expect(pills(tree)).toEqual(["OVERALL", "SQ1", "SQ2", "SQ3"]);
    expect(cuts(tree)).toEqual([["1", "ELIMINATED IN SQ2 · P2 MAY HAVE ADVANCED WITHOUT A TIME"]]);
  });

  // 2023 Azerbaijan Sprint Shootout (OpenF1 session 9278, #2099).
  it("a qualifier who advanced but set no later time is not asserted eliminated", async () => {
    const mk = (pos: number, num: number, dur: (number | null)[]) => row(pos, num, 10, null, dur, dur.map(() => 0));
    const tree = await render(meta({ sessionKey: 9278, name: "Sprint Shootout", type: "Qualifying" }),
      [mk(1, 1, [102.8, 102.5, 101.7]), mk(2, 63, [103.8, 102.9, 101.8]),
       mk(3, 16, [103.9, 103.4, null]), mk(4, 11, [104.2, 103.4, null]),
       mk(5, 55, [104.0, null, null]), mk(6, 44, [104.5, null, null])],
      [drv(16, "NOR", "N", "T"), drv(55, "SAR", "S", "T")]);
    expect(cuts(tree)).toEqual([["2", "ELIMINATED IN SQ2 · P3 MAY HAVE ADVANCED WITHOUT A TIME"],
                                ["4", "ELIMINATED IN SQ1 · P5 MAY HAVE ADVANCED WITHOUT A TIME"]]);
    clickPill(tree, "SQ2");
    expect(cuts(tree).map((x) => x[1])).toEqual(["ELIMINATED IN SQ2 · NOR MAY HAVE ADVANCED WITHOUT A TIME"]);
  });

  it("retirements sort last and say why in the time column", async () => {
    const tree = await render(meta({ sessionKey: 11353, name: "Race", type: "Race" }), [
      row(null, 16, 45, 0, null, null, { dnf: true }),
      row(1, 63, 72, 25, 5400, 0),
      row(null, 1, 0, 0, null, null, { dns: true }),
    ]);
    const r = rows(tree);
    expect(r[0]![0]).toBe("1");   // the classified finisher leads the table
    expect(r.slice(1).map((x) => x[0])).toEqual(["—", "—"]);
    expect(r[1]!.slice(4, 6)).toEqual(["DNF", "—"]);
    expect(r[2]!.slice(4, 6)).toEqual(["DNS", "—"]);
  });

  // 2024 Belgian GP (OpenF1 session 9574, #2100).
  it("a DSQ / DNS / DNF that keeps a duration still says why", async () => {
    const tree = await render(meta({ sessionKey: 9574, name: "Race", type: "Race" }), [
      row(1, 16, 44, 25, 4796.5, 0),
      row(null, 63, 44, 0, 4797.04, null, { dsq: true }),
      row(null, 1, 20, 0, 2500, null, { dnf: true }),
      row(null, 2, 0, 0, 99, null, { dns: true }),
    ]);
    const r = rows(tree);
    expect(r[0]![4]).toBe("1:19:56.500");
    expect(r.slice(1).map((x) => x[4]).sort()).toEqual(["DNF", "DNS", "DSQ"]);
    expect(r.slice(1).every((x) => x[5] === "—")).toBe(true);
  });

  // OpenF1 answers HTTP 404 {"detail":"No results found."} for a session that
  // has not published (#2185); the real transport resolves that as [].
  it("an unpublished session (OpenF1 404 'No results found.') shows the empty-tab copy, not an error", async () => {
    const real = stubDeps([]).api;   // the fixture fetch answers every unrouted URL with that 404
    const m = meta({ sessionKey: 11392, name: "Qualifying", type: "Qualifying" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { loadResults } = create(deps(m, { sessionResult: (k) => real.sessionResult(k, 60e3), sessionDrivers: () => Promise.resolve(DRIVERS) }));
      const p = loadResults();
      await vi.runAllTimersAsync();
      const tree = await p;
      await vi.runAllTimersAsync();
      const empty = tree.querySelectorAll(".dh-empty");
      expect(empty.length).toBe(1);
      expect(empty[0]!.textContent).toBe("NOTHING YET");
      expect(tree.tabOutcome?.status).toBe("empty");
    } finally { vi.useRealTimers(); }
  });

  it("a failed fetch does not read as an unpublished session", async () => {
    const outcomes: string[] = [];
    const tree = await render(meta({ sessionKey: 7, name: "Race", type: "Race" }), null, DRIVERS,
      { sessionResult: () => Promise.reject(new Error("429")) },
      { onOutcome: (node) => { outcomes.push(String(node.tabOutcome?.status)); } });
    const msg = tree.querySelectorAll(".dh-empty");
    expect(msg.length).toBe(1);
    expect(msg[0]!.textContent).not.toBe("NOTHING YET");
    expect(msg[0]!.textContent).toMatch(/Couldn't load/);
    expect(outcomes).toEqual(["loading", "failed"]);
  });

  it("a missing driver list still classifies by car number", async () => {
    const tree = await render(meta({ sessionKey: 5, name: "Practice 1", type: "Practice" }),
      [row(1, 44, 20, null, 80.5, 0)], DRIVERS, { sessionDrivers: () => Promise.reject(new Error("429")) });
    expect(rows(tree)[0]).toEqual(["1", "#44 Car 44", "—", "20", "1:20.500", "—"]);
  });

  it("RESULTS header remaps a moved venue through placeLabel", async () => {
    const tree = await render(
      meta({ sessionKey: 1, name: "Race", type: "Race", circuit: "Kuala Lumpur", country: "Bahrain", dateStart: "2026-10-04T12:00:00Z" }),
      [row(1, 1, 57, 25, 5400, 0)]);
    const metaEl = tree.querySelector(".dh-lr-meta")!;
    expect(metaEl.textContent).toMatch(/Kuala Lumpur, Malaysia/);
    expect(metaEl.textContent).not.toMatch(/Kuala Lumpur, Bahrain/);
  });
});

const ROUTES: [string, string][] = [
  ["/session_result?session_key=11377", "openf1-11377-session-result.json"],
  ["/drivers?session_key=11377", "openf1-11377-drivers.json"],
];

describe("results tab mounted against the recorded Baku 2026 race (session 11377)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
  });
  afterEach(() => { vi.useRealTimers(); });

  it("paints the picker, the session header and a 22-row race classification", async () => {
    const m = meta({ sessionKey: 11377, meetingKey: 1295, year: 2026, name: "Race", type: "Race",
      circuit: "Baku", country: "Azerbaijan", dateStart: "2026-09-20T11:00:00+00:00" });
    const d = stubDeps(ROUTES);
    d.sel.meta = m;
    const host = document.createElement("div");
    const tab = mount(host, d);
    expect(host.querySelector(".dh-loading")).toBeTruthy();
    await vi.runAllTimersAsync();
    await vi.waitFor(() => expect(host.querySelector("table.dh-table")).toBeTruthy());
    expect(host.querySelector(".dh-picker")).toBeTruthy();
    expect(host.querySelector("#dh-lr-head .dh-lr-name")!.textContent).toBe("Race");
    expect(host.querySelector(".dh-lr-meta")!.textContent).toMatch(/^Baku, Azerbaijan · /);
    expect(headers(host)).toEqual(["POS", "DRIVER", "TEAM", "LAPS", "TIME", "GAP", "PTS"]);
    const r = rows(host);
    expect(r.length).toBe(22);
    expect(r[0]![0]).toBe("1");
    expect(r[0]![1]).toMatch(/^RUS /);
    expect(r[0]![4]).toBe("1:38:02.143");   // 5882.143 s
    expect(r[0]!.slice(5)).toEqual(["—", "25"]);
    expect(r[r.length - 1]![4]).toBe("DNF");   // car 18, out after 7 laps, sorts last
    expect(host.querySelector("tr.dh-lr-p1")).toBeTruthy();
    expect((host.firstElementChild as ResultsNode).tabOutcome?.status).toBe("ready");
    tab.unmount();
    expect(host.childNodes.length).toBe(0);
  });

  it("no selected session reads NO_RESULT_MSG", async () => {
    const d = stubDeps(ROUTES, { NO_RESULT_MSG: "No classification" });
    d.sel.sessionKey = null;
    const host = document.createElement("div");
    const tab = mount(host, d);
    await tab.refresh();
    expect(host.querySelector(".dh-res-body .dh-empty")!.textContent).toBe("No classification");
    tab.unmount();
  });
});
