import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createF1Api, gapValue, placeLabel, TTL_HISTORIC, TTL_LATEST } from "../../../src/data/api";
import { setDataLog } from "../../../src/data/log";
import { fixtureFetch, MemoryStorage } from "./fixtures";

const ROUTES: [string, string][] = [
  ["/ergast/f1/2025.json", "jolpica-2025-schedule.json"],
  ["/2025/driverstandings.json", "jolpica-2025-driverstandings.json"],
  ["/2025/constructorstandings.json", "jolpica-2025-constructorstandings.json"],
  ["/meetings?year=2026", "openf1-2026-meetings.json"],
  ["/sessions?meeting_key=1295", "openf1-1295-sessions.json"],
  ["/session_result?session_key=11377", "openf1-11377-session-result.json"],
  ["/drivers?session_key=11377", "openf1-11377-drivers.json"],
  ["/weather?session_key=11377", "openf1-11377-weather.json"],
  ["/stints?session_key=11377&driver_number=1", "openf1-11377-stints-1.json"],
  ["/pit?session_key=11377", "openf1-11377-pit.json"],
  ["/laps?session_key=11377&driver_number=1", "openf1-11377-laps-1.json"],
  ["/intervals?session_key=11377", "openf1-11377-intervals.json"],
  ["/position?session_key=11377", "openf1-11377-position.json"],
  ["/car_data?session_key=11377&driver_number=1", "openf1-11377-car_data-1-lap28.json"],
  ["/location?session_key=11377&driver_number=1", "openf1-11377-location-1-lap28.json"],
];

async function run<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
  setDataLog({ info: () => {}, warn: () => {} });
});
afterEach(() => { vi.useRealTimers(); });

function client() {
  const fetch = fixtureFetch(ROUTES);
  const storage = new MemoryStorage();
  return { api: createF1Api({ fetch, storage }), fetch, storage };
}

describe("Jolpica", () => {
  it("maps the season schedule with sprint sessions", async () => {
    const { api, fetch } = client();
    const races = await run(api.schedule(2025));
    expect(fetch.calls[0]).toBe("https://api.jolpi.ca/ergast/f1/2025.json");
    expect(races.length).toBe(24);
    const first = races[0]!;
    expect(first).toMatchObject({ round: 1, name: "Australian Grand Prix", country: "Australia", hasSprint: false });
    expect(first.sessions.fp1).toEqual({ date: expect.any(String), time: expect.any(String) });
    const sprint = races.find((r) => r.hasSprint)!;
    expect(sprint.sessions.sq && sprint.sessions.s).toBeTruthy();
  });

  it("maps the standings and treats a past season as historic", async () => {
    const { api, storage } = client();
    const drivers = await run(api.driverStandings(2025));
    expect(drivers[0]).toMatchObject({ pos: 1, code: expect.any(String), team: expect.any(String) });
    expect(drivers[0]!.points).toBeGreaterThan(drivers[1]!.points - 1);
    const teams = await run(api.constructorStandings(2025));
    expect(teams[0]).toMatchObject({ pos: 1, name: "McLaren" });
    expect([...storage.map.keys()]).toContain("a26.api.https://api.jolpi.ca/ergast/f1/2025/driverstandings.json");
  });
});

describe("OpenF1", () => {
  it("drops cancelled meetings and marks session dates for the TTL", async () => {
    const { api } = client();
    const ms = await run(api.meetings(2026));
    expect(ms.some((m) => m.cancelled)).toBe(false);
    expect(ms.find((m) => m.meetingKey === 1282)).toBeUndefined();   // cancelled Bahrain
    expect(api.sessionTtl(11377)).toBe(TTL_LATEST);   // not seen yet
    const ss = await run(api.sessionsForMeeting(1295));
    expect(ss.map((s) => s.name)).toEqual(["Practice 1", "Practice 2", "Practice 3", "Qualifying", "Race"]);
    // Baku race started 2026-09-26: frozen long ago, a week's TTL.
    expect(api.sessionTtl(11377)).toBe(TTL_HISTORIC);
  });

  it("maps a race classification, drivers, weather, stints and pits", async () => {
    const { api } = client();
    const res = await run(api.sessionResult(11377));
    expect(res.length).toBe(22);
    expect(res[0]).toMatchObject({ pos: 1, dnf: false });
    expect(typeof res[0]!.duration).toBe("number");
    const ds = (await run(api.sessionDrivers(11377)))!;
    expect(ds.find((d) => d.num === 1)).toMatchObject({ code: "NOR", team: "McLaren", color: "F47600" });
    const w = (await run(api.weather(11377)))!;
    expect(w.airT).toEqual(expect.any(Number));
    const st = await run(api.stints(11377, 1));
    expect(st[0]).toMatchObject({ num: 1, stint: 1 });
    const pits = await run(api.pits(11377));
    expect(pits.length).toBeGreaterThan(0);
    expect(pits.every((p) => p.duration === null || p.duration > 0)).toBe(true);
  });

  it("folds positions and intervals to each driver's latest row", async () => {
    const { api } = client();
    const pos = (await run(api.positions(11377)))!;
    expect(pos.length).toBe(22);
    expect(pos.map((p) => p.pos)).toEqual([...pos.map((p) => p.pos)].sort((a, b) => a! - b!));
    const gaps = (await run(api.intervals(11377)))!;
    expect(Object.keys(gaps).length).toBe(19);   // three retirements stop streaming
  });

  it("finds the fastest lap and its telemetry window", async () => {
    const { api, fetch } = client();
    const lap = (await run(api.fastestLap(11377, 1)))!;
    expect(lap).toMatchObject({ lapNumber: 28, lapDuration: 107.761, isPitOut: false });
    const car = await run(api.carData(11377, 1, lap.dateStart, "2026-09-26T11:54:40.099000+00:00"));
    expect(fetch.calls.at(-1)).toContain("&date>=2026-09-26T11%3A52%3A52.338000%2B00%3A00");
    expect(car.length).toBe(400);
    expect(car[0]!.t).toBe(0);
    expect(car.every((c, i) => i === 0 || c.date > car[i - 1]!.date)).toBe(true);
    const loc = await run(api.locationData(11377, 1, lap.dateStart, null));
    expect(loc.length).toBeGreaterThan(300);
    expect(loc.some((p) => p.x === 0 && p.y === 0)).toBe(false);
  });

  it("treats OpenF1's 404 'No results found.' as an empty answer", async () => {
    const { api } = client();
    expect(await run(api.sessionResult(999999))).toEqual([]);
  });

  it("builds delta URLs with an encoded date cursor and never caches them", async () => {
    const { api, fetch, storage } = client();
    const d = await run(api.liveIntervals(11377, "2026-09-26T12:00:00Z"));
    expect(fetch.calls[0]).toBe("https://api.openf1.org/v1/intervals?session_key=11377&date%3E=2026-09-26T12%3A00%3A00Z");
    expect(d.cursor).toMatch(/^2026-09-26T/);
    expect(storage.length).toBe(0);
  });
});

describe("pure helpers", () => {
  it("keeps a lapped gap as its label", () => {
    expect(gapValue("+1 LAP ")).toBe("+1 LAP");
    expect(gapValue("12.5")).toBe(12.5);
    expect(gapValue(null)).toBe(null);
  });
  it("labels a venue whose country follows the GP title", () => {
    expect(placeLabel("Kuala Lumpur", "Bahrain")).toBe("Kuala Lumpur, Malaysia");
    expect(placeLabel("Baku", "Azerbaijan", " · ")).toBe("Baku · Azerbaijan");
  });
});
