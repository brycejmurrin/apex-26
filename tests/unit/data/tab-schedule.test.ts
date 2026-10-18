// @vitest-environment happy-dom
// THE SCHEDULE'S DATE AND TIME COME FROM ONE INSTANT IN ONE ZONE. Ported from
// f1-game tests/unit/data-schedule-tz.test.mjs: the zone is pinned BEFORE any
// Date use (Node re-reads process.env.TZ), so a Las Vegas GP (2026-11-22
// 04:00Z) must read 21 Nov in California, not 22.
const PREV_TZ = process.env.TZ;
process.env.TZ = "America/Los_Angeles";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDataLog } from "../../../src/data/log";
import {
  countdown, create, dateLabel, isUpcoming, mount, nextFlipAt, nextRace, raceInstant, weekendSessions,
  type ScheduleNode,
} from "../../../src/data/tabs/schedule";
import { stubDeps } from "./hub-stub";

afterAll(() => {
  if (PREV_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = PREV_TZ;
});

const VEGAS = { date: "2026-11-22", time: "04:00:00Z", name: "Las Vegas Grand Prix" };

describe("schedule time helpers", () => {
  it("the zone pin took effect", () => {
    expect(new Date(Date.parse("2026-11-22T04:00:00Z")).getDate()).toBe(21);   // LA is UTC-8 in November
  });

  it("Las Vegas: the date is the viewer's LOCAL day of the race instant (21 Nov in LA)", () => {
    const label = dateLabel(VEGAS);
    expect(label).toMatch(/21/);
    expect(label).not.toMatch(/22/);
    expect(label).toMatch(/Nov/);
  });

  it("a date-only entry stays a UTC calendar day (the earlier UTC+13 fix)", () => {
    expect(dateLabel({ date: "2026-11-22" })).toMatch(/22/);
  });

  it("NEXT compares the race instant with now, not today's UTC date", () => {
    const at = Date.parse("2026-11-22T04:00:00Z");
    expect(isUpcoming(VEGAS, at - 60e3)).toBe(true);              // a minute before lights out
    expect(isUpcoming(VEGAS, at + 60 * 60e3)).toBe(true);         // an hour in: still running
    // three hours after the start it is over, even though the UTC date is still the 22nd
    expect(isUpcoming(VEGAS, at + 3 * 3600e3)).toBe(false);
    // Date-only entries keep the day comparison.
    expect(isUpcoming({ date: "2026-11-22" }, Date.parse("2026-11-22T20:00:00Z"))).toBe(true);
    expect(isUpcoming({ date: "2026-11-22" }, Date.parse("2026-11-23T01:00:00Z"))).toBe(false);
  });

  it("a malformed time falls back to the date-only rules", () => {
    const r = { date: "2026-11-22", time: "garbage" };
    expect(Number.isNaN(raceInstant(r))).toBe(true);
    expect(dateLabel(r)).toMatch(/22/);
  });

  // #2190 (3): the Schedule node is reused for hours, so NEXT must say when it
  // moves on; the hub drops a reused node whose `nextFlipAt` has passed.
  it("nextFlipAt: NEXT moves on at race start + 2 h (or the next UTC day for a date-only entry)", () => {
    const at = Date.parse("2026-11-22T04:00:00Z");
    const items = [{ date: "2026-11-08", time: "18:00:00Z" }, VEGAS, { date: "2026-12-06", time: "13:00:00Z" }];
    expect(nextFlipAt(items, at - 3600e3)).toBe(at + 2 * 3600e3);
    expect(nextFlipAt(items, at + 2 * 3600e3)).toBe(Date.parse("2026-12-06T15:00:00Z"));
    expect(nextFlipAt([{ date: "2026-11-22" }], Date.parse("2026-11-22T10:00:00Z"))).toBe(Date.parse("2026-11-23T00:00:00Z"));
    expect(nextFlipAt(items, Date.parse("2027-01-01T00:00:00Z"))).toBe(Infinity);
  });

  it("nextRace uses instants across DST and keeps a date-only fallback", () => {
    const springForward = [
      { name: "Finished", date: "2026-03-08", time: "07:30:00Z" },
      { name: "DST edge", date: "2026-03-08", time: "10:30:00Z" },
      { name: "Later", date: "2026-03-15" },
    ];
    expect(nextRace(springForward, Date.parse("2026-03-08T10:00:00Z"))?.name).toBe("DST edge");
    expect(nextRace(springForward, Date.parse("2026-03-08T13:00:01Z"))?.name).toBe("Later");
    expect(nextRace([{ name: "Calendar only", date: "2026-11-01" }], Date.parse("2026-11-01T23:59:59Z"))?.name).toBe("Calendar only");
    expect(nextRace([{ date: "2026-11-01" }], Date.parse("2026-11-02T00:00:00Z"))).toBe(null);
  });

  it("weekendSessions returns conventional and sprint weekends in UTC order", () => {
    const normal = weekendSessions({
      date: "2026-03-08", time: "05:00:00Z",
      sessions: {
        fp1: { date: "2026-03-06", time: "01:30:00Z" },
        fp2: { date: "2026-03-06", time: "05:00:00Z" },
        fp3: { date: "2026-03-07", time: "01:30:00Z" },
        q: { date: "2026-03-07", time: "05:00:00Z" },
      },
    });
    expect(normal.map((x) => x.key)).toEqual(["fp1", "fp2", "fp3", "q", "r"]);
    expect(normal.map((x) => x.label)).toEqual(["FP1", "FP2", "FP3", "Q", "R"]);
    expect(normal.every((x) => Number.isFinite(x.startMs) && x.endMs > x.startMs && x.est === true)).toBe(true);

    const sprint = weekendSessions({
      date: "2026-10-25", time: "19:00:00Z",
      sessions: {
        fp1: { date: "2026-10-23", time: "17:30:00Z" },
        sq: { date: "2026-10-23", time: "21:30:00Z" },
        s: { date: "2026-10-24", time: "18:00:00Z" },
        q: { date: "2026-10-24", time: "22:00:00Z" },
      },
    });
    expect(sprint.map((x) => x.key)).toEqual(["fp1", "sq", "s", "q", "r"]);
    const len = (k: string) => { const s = sprint.find((x) => x.key === k)!; return s.endMs - s.startMs; };
    expect(len("sq")).toBe(45 * 60e3);
    expect(len("s")).toBe(30 * 60e3);
    // a date-only race cannot invent a session instant
    expect(weekendSessions({ date: "2026-11-22" })).toEqual([]);
  });

  it("countdown is stable at boundaries and never goes negative", () => {
    expect(countdown(2 * 86400e3 + 3 * 3600e3 + 4 * 60e3 + 5e3)).toBe("2d 03h 04m");
    expect(countdown(3 * 3600e3 + 4 * 60e3 + 5e3)).toBe("3h 04m 05s");
    expect(countdown(4 * 60e3 + 5e3)).toBe("4m 05s");
    expect(countdown(999)).toBe("0m 00s");
    expect(countdown(0)).toBe("STARTED");
    expect(countdown(-1)).toBe("STARTED");
  });
});

const ROUTES: [string, string][] = [["/ergast/f1/2025.json", "jolpica-2025-schedule.json"]];

describe("schedule tab DOM", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // Mid-2025: api.season() reads the clock, so the 2025 fixture is "this year".
    vi.setSystemTime(new Date("2025-06-10T12:00:00Z"));
    setDataLog({ info: () => {}, warn: () => {} });
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("schedule venue lines do not stamp a native title (scroll leaves it hung)", async () => {
    const deps = stubDeps([]);
    const api = { ...deps.api, schedule: () => Promise.resolve([{
      round: 1, name: "Australian Grand Prix", circuit: "Albert Park Circuit", locality: "Melbourne",
      country: "Australia", date: "2026-03-08", time: "05:00:00Z", hasSprint: false, sessions: {},
    }]) };
    const tab = create({ ...deps, api });
    const wrap = await tab.loadSchedule();
    const sub = wrap.querySelector<HTMLElement>(".dh-race-sub")!;
    expect(sub).toBeTruthy();
    expect(sub.getAttribute("title")).toBe(null);   // no title until the line actually ellipsizes
    sub.dispatchEvent(new Event("mouseenter"));
    expect(sub.getAttribute("title")).toBe(null);   // a fully-visible line still has no title
    Object.defineProperty(sub, "scrollWidth", { value: 400, configurable: true });
    Object.defineProperty(sub, "clientWidth", { value: 120, configurable: true });
    sub.dispatchEvent(new Event("mouseenter"));
    expect(sub.getAttribute("title")).toBe("Albert Park Circuit · Melbourne, Australia");
    sub.dispatchEvent(new Event("mouseleave"));
    expect(sub.getAttribute("title")).toBe(null);   // leave clears the tip so scroll cannot hang it
    tab.dispose();
  });

  it("mounts the 2025 calendar with one NEXT race, a live countdown tile and nextFlipAt", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const m = mount(host, stubDeps(ROUTES));
    expect(host.querySelector(".dh-loading")).toBeTruthy();   // the spinner first
    await vi.runAllTimersAsync();
    await vi.waitFor(() => expect(host.querySelector(".dh-race-grid")).toBeTruthy());
    const wrap = host.firstElementChild as ScheduleNode;
    expect(wrap.className).toBe("dh-tabbody");
    expect(host.querySelector(".dh-loading")).toBe(null);
    expect(host.querySelector("h3.dh-section")!.textContent).toBe("2025 CALENDAR");

    const rows = [...host.querySelectorAll(".dh-race")];
    expect(rows.length).toBe(24);
    expect(rows[0]!.querySelector(".dh-race-round")!.textContent).toBe("R1");
    expect(rows[0]!.querySelector(".dh-race-name span")!.textContent).toBe("Australian Grand Prix");
    const next = host.querySelectorAll(".dh-race-next");
    expect(next.length).toBe(1);
    expect(next[0]!.querySelector(".dh-chip-next")!.textContent).toBe("NEXT");
    expect(host.querySelectorAll(".dh-chip-sprint").length).toBeGreaterThan(0);
    expect(rows.every((r) => r.querySelector(".dh-race-date")!.textContent !== "—")).toBe(true);

    // The NEXT tile names the same race as the NEXT row and lists its sessions.
    const tile = host.querySelector("[data-nextgp=tile]")!;
    expect(tile.querySelector("[data-nextgp=name]")!.textContent)
      .toBe(next[0]!.querySelector(".dh-race-name span")!.textContent);
    const clock = tile.querySelector<HTMLElement>("[data-nextgp=countdown]")!;
    expect(clock.getAttribute("role")).toBe("timer");
    expect(clock.textContent).toMatch(/^\d+d \d\dh \d\dm$/);
    expect(tile.querySelectorAll("[data-nextgp=session]").length).toBeGreaterThanOrEqual(5);
    expect(Number.isFinite(wrap.nextFlipAt)).toBe(true);
    expect(wrap.nextFlipAt!).toBeGreaterThan(Date.now());

    m.unmount();
    expect(host.childNodes.length).toBe(0);
  });

  it("an empty calendar reads as the empty-state message", async () => {
    const deps = stubDeps([]);
    const host = document.createElement("div");
    const m = mount(host, { ...deps, api: { ...deps.api, schedule: () => Promise.resolve([]) } });
    await m.refresh();
    expect(host.querySelector(".dh-empty")!.textContent).toBe("No calendar data available yet.");
    m.unmount();
  });

  it("a failed load shows the error block with a working RETRY", async () => {
    const deps = stubDeps([]);
    let fail = true;
    const api = { ...deps.api, schedule: () => (fail ? Promise.reject(new Error("503")) : Promise.resolve([])) };
    const host = document.createElement("div");
    const m = mount(host, { ...deps, api });
    await m.refresh();
    expect(host.querySelector(".dh-error")!.getAttribute("data-reason")).toBe("upstream");
    fail = false;
    host.querySelector<HTMLButtonElement>(".dh-retry")!.click();
    await vi.waitFor(() => expect(host.querySelector(".dh-empty")).toBeTruthy());
    m.unmount();
  });
});
