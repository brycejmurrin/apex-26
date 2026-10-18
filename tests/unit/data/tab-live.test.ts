// @vitest-environment happy-dom
/**
 * LIVE tab (src/data/tabs/live.ts). Helper assertions ported from f1-game
 * tests/unit/async-lifecycle.test.mjs:530-609; mount smoke runs against the
 * recorded Baku 2026 race (session 11377) fixtures, never the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createF1Api, type F1Api, type Session } from "../../../src/data/api";
import { setDataLog } from "../../../src/data/log";
import {
  mergeIntervalBatch, mergePositionBatch, mount, newLiveState, sessionStatus, sessionTimeLabel,
} from "../../../src/data/tabs/live";
import { fixtureFetch, MemoryStorage } from "./fixtures";
import { stubDeps } from "./hub-stub";

const ROUTES: [string, string][] = [
  ["/drivers?session_key=11377", "openf1-11377-drivers.json"],
  ["/weather?session_key=11377", "openf1-11377-weather.json"],
  ["/intervals?session_key=11377", "openf1-11377-intervals.json"],
  ["/position?session_key=11377", "openf1-11377-position.json"],
];

const BAKU_RACE: Session = {
  sessionKey: 11377, meetingKey: 1295, year: 2026, name: "Race", type: "Race",
  circuit: "Baku", country: "Azerbaijan", dateStart: "2026-09-26T11:00:00+00:00",
};

describe("LIVE helpers", () => {
  it("labels sessions as upcoming, live, or completed", () => {
    const now = Date.parse("2026-09-18T12:00:00Z");
    expect(sessionStatus({ type: "Race", dateStart: "2026-09-18T14:00:00Z" }, now)).toBe("UPCOMING");
    expect(sessionStatus({ type: "Race", dateStart: "2026-09-18T10:00:00Z" }, now)).toBe("LIVE");
    expect(sessionStatus({ type: "Race", dateStart: "2026-09-13T10:00:00Z" }, now)).toBe("COMPLETED");
    // Non-race sessions are live for 2 h, not 4.
    expect(sessionStatus({ type: "Qualifying", dateStart: "2026-09-18T09:30:00Z" }, now)).toBe("COMPLETED");
    expect(sessionStatus({}, now)).toBe("LIVE");
  });

  it("session time copy agrees with the status badge", () => {
    const meta = { dateStart: "2026-09-18T10:00:00Z" };
    const fmt = (value: string) => `[${value}]`;
    expect(sessionTimeLabel(meta, "UPCOMING", fmt)).toBe("Starts [2026-09-18T10:00:00Z]");
    expect(sessionTimeLabel(meta, "LIVE", fmt)).toBe("Started [2026-09-18T10:00:00Z]");
    expect(sessionTimeLabel(meta, "COMPLETED", fmt)).toBe("Started [2026-09-18T10:00:00Z]");
    expect(sessionTimeLabel({}, "COMPLETED", fmt)).toBe("");
  });

  it("mergeIntervalBatch ignores values:null and never writes meta keys into gaps", () => {
    const state = { intervals: { 44: 1.2 } as Record<string, number | string | null>, intervalCursor: "a" as string | null };
    mergeIntervalBatch(state, { values: null, cursor: "b" });
    expect(state.intervals).toEqual({ 44: 1.2 });
    expect(state.intervalCursor).toBe("b");
    expect(state.intervals.values).toBeUndefined();
    expect(state.intervals.cursor).toBeUndefined();

    mergeIntervalBatch(state, { values: { 4: 0.5 }, cursor: "c" });
    expect(state.intervals[4]).toBe(0.5);
    expect(state.intervals[44]).toBe(1.2);

    // Snapshot shape from intervals(): a plain number map, no values wrapper.
    const plain = { intervals: {}, intervalCursor: null };
    mergeIntervalBatch(plain, { 44: 0, 4: 1.1 });
    expect(plain.intervals).toEqual({ 44: 0, 4: 1.1 });
  });

  it("mergeIntervalBatch keeps lapped '+1 LAP' gaps as strings and never moves the cursor back", () => {
    const state = newLiveState();
    mergeIntervalBatch(state, { values: { 1: 0, 18: "+1 LAP", 43: 12.5 }, cursor: "2026-09-26T12:00:00Z" });
    expect(state.intervals[18]).toBe("+1 LAP");
    mergeIntervalBatch(state, { values: { 43: "+2 LAPS" }, cursor: "2026-09-26T11:00:00Z" });
    expect(state.intervals[43]).toBe("+2 LAPS");
    expect(state.intervals[1]).toBe(0);
    expect(state.intervalCursor).toBe("2026-09-26T12:00:00Z");
  });

  it("mergePositionBatch folds a delta onto per-driver state without dropping unchanged drivers", () => {
    const state = newLiveState();
    mergePositionBatch(state, { values: [{ num: 44, pos: 1 }, { num: 4, pos: 2 }], cursor: "2026-07-26T14:44:00Z" });
    expect(state.positionCursor).toBe("2026-07-26T14:44:00Z");
    const merged = mergePositionBatch(state, { values: [{ num: 4, pos: 1 }], cursor: "2026-07-26T14:44:30Z" });
    expect(merged.map((p) => [p.num, p.pos]).sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))).toEqual([[4, 1], [44, 1]]);
    expect(state.positionCursor).toBe("2026-07-26T14:44:30Z");
    // An empty delta (no new rows) keeps state and cursor.
    const same = mergePositionBatch(state, { values: [], cursor: null });
    expect(same).toHaveLength(2);
    expect(state.positionCursor).toBe("2026-07-26T14:44:30Z");
    // A plain snapshot array (positions()) folds too; null-num rows are skipped.
    mergePositionBatch(state, [{ num: 16, pos: 3 }, { num: null, pos: 4 }]);
    expect(state.positions.size).toBe(3);
    expect(mergePositionBatch(state, null).map((p) => p.num)).toEqual([44, 4, 16]);
  });
});

describe("LIVE mount", () => {
  let host: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
    setDataLog({ info: () => {}, warn: () => {} });
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => {
    host.remove();
    vi.useRealTimers();
  });

  function setup(routes = ROUTES, patch: Partial<F1Api> = {}) {
    const fetch = fixtureFetch(routes);
    const api: F1Api = { ...createF1Api({ fetch, storage: new MemoryStorage() }), ...patch };
    const deps = stubDeps(routes, { api });
    deps.sel.meta = BAKU_RACE;
    return { deps, fetch };
  }
  const flush = () => vi.advanceTimersByTimeAsync(5000);

  it("renders a pinned session's card, weather and classification", async () => {
    const { deps } = setup();
    const tab = mount(host, deps);
    expect(host.querySelector(".dh-loading")).not.toBeNull();
    await flush();

    expect(host.querySelector(".dh-split .dh-split-L .dh-picker")).not.toBeNull();
    const title = host.querySelector(".dh-live-title")!;
    expect(title.textContent).toContain("Race");
    expect(host.querySelector(".dh-live-state")!.getAttribute("data-state")).toBe("completed");
    expect([...host.querySelectorAll(".dh-live-sub")].map((n) => n.textContent)).toEqual(
      ["Baku · Azerbaijan", "Started 2026-09-26T11:00:00+00:00"]);

    const data = host.querySelector(".dh-split-R > .dh-tabbody")!;
    expect(data.getAttribute("data-state")).toBe("ready");
    expect(data.getAttribute("aria-busy")).toBe("false");
    const wxLabels = [...data.querySelectorAll(".dh-wx-label")].map((n) => n.textContent);
    expect(wxLabels).toEqual(["AIR", "TRACK", "HUMIDITY", "RAIN", "WIND"]);

    const rows = [...data.querySelectorAll(".dh-class-rows .dh-row")];
    expect(rows.length).toBeGreaterThan(15);
    const posList = rows.map((r) => Number(r.querySelector(".dh-pos")!.textContent));
    expect(posList).toEqual([...posList].sort((a, b) => a - b));
    expect(posList[0]).toBe(1);
    // The leader has no gap bar; everyone else with a numeric gap does.
    expect(rows[0]!.querySelector(".dh-live-gapbar")).toBeNull();
    expect(rows.some((r) => /^\+\d+\.\d{3}$/.test(r.querySelector(".dh-live-gaplbl")?.textContent ?? ""))).toBe(true);
    // Driver chips come from /drivers (OpenF1 team_colour wins).
    expect(rows.every((r) => /^[A-Z]{3}$/.test(r.querySelector(".dh-codechip")!.textContent ?? ""))).toBe(true);
    expect(host.querySelector(".dh-live-updated")!.textContent).toMatch(/^updated /);

    // TEAM sort regroups rows and drops the gap column.
    const teamBtn = [...data.querySelectorAll<HTMLButtonElement>(".dh-sortbtn")].find((b) => b.textContent === "TEAM")!;
    teamBtn.click();
    expect(teamBtn.getAttribute("aria-pressed")).toBe("true");
    expect(data.querySelector(".dh-live-gapwrap")).toBeNull();
    const teams = [...data.querySelectorAll(".dh-live-team")].map((n) => n.textContent ?? "");
    expect(teams).toEqual([...teams].sort((a, b) => a.localeCompare(b)));
    tab.unmount();
    expect(host.childNodes.length).toBe(0);
  });

  it("shows a lapped '+1 LAP' gap as text, not a bar", async () => {
    const { deps } = setup(ROUTES, {
      liveIntervals: () => Promise.resolve({ values: { 1: 0, 63: 2.5, 16: "+1 LAP" }, cursor: "2026-09-26T13:00:00Z" }),
      livePositions: () => Promise.resolve({ values: [{ num: 1, pos: 1 }, { num: 63, pos: 2 }, { num: 16, pos: 3 }], cursor: "2026-09-26T13:00:00Z" }),
    });
    mount(host, deps);
    await flush();
    const rows = [...host.querySelectorAll(".dh-class-rows .dh-row")];
    expect(rows).toHaveLength(3);
    expect(rows[1]!.querySelector(".dh-live-gaplbl")!.textContent).toBe("+2.500");
    expect(rows[1]!.querySelector(".dh-live-gapbar")).not.toBeNull();
    expect(rows[2]!.querySelector(".dh-live-gaplbl")!.textContent).toBe("+1 LAP");
    expect(rows[2]!.querySelector(".dh-live-gapbar")).toBeNull();
  });

  it("keeps a failed load distinct from an empty one", async () => {
    const down = () => Promise.reject(new Error("HTTP 500"));
    const failed = setup(ROUTES, { weather: down, livePositions: down, sessionDrivers: down, liveIntervals: down });
    mount(host, failed.deps);
    await flush();
    const data = host.querySelector(".dh-split-R > .dh-tabbody")!;
    expect(data.getAttribute("data-state")).toBe("failed");
    expect(data.querySelector(".dh-error[data-refresh-error] .dh-error-msg")!.textContent).toBe("Couldn't load live data. Try again.");

    // OpenF1's 404 "No results found" is a valid empty answer, not a failure.
    host.textContent = "";
    mount(host, setup([]).deps);
    await flush();
    const empty = host.querySelector(".dh-split-R > .dh-tabbody")!;
    expect(empty.getAttribute("data-state")).toBe("empty");
    expect(empty.querySelector(".dh-empty")!.textContent).toBe("No live data");
  });

  it("a live-auth gate (401) shows the API's message and turns AUTO off", async () => {
    const gate = () => Promise.reject(Object.assign(new Error("Live F1 session: sign-in required"), { status: 401 }));
    const { deps } = setup(ROUTES, { livePositions: gate });
    mount(host, deps);
    await flush();
    const data = host.querySelector(".dh-split-R > .dh-tabbody")!;
    expect(data.getAttribute("data-state")).toBe("failed");
    expect(data.querySelector(".dh-error-msg")!.textContent).toBe("Live F1 session: sign-in required");
    expect(host.querySelector(".dh-livebtn[data-aria-toggle]")!.getAttribute("aria-pressed")).toBe("false");
  });

  it("shows the empty message when no session is selected", async () => {
    const { deps } = setup();
    deps.sel.meta = null;
    mount(host, deps);
    await flush();
    expect(host.querySelector(".dh-split-R .dh-empty")!.textContent).toBe("No live data");
  });

  it("AUTO polls every 30 s after settlement with a delta cursor, and unmount stops it", async () => {
    const { deps, fetch } = setup();
    const tab = mount(host, deps);
    await flush();
    const positionCalls = () => fetch.calls.filter((u) => u.includes("/position?"));
    expect(positionCalls()).toHaveLength(1);
    expect(positionCalls()[0]).not.toContain("date%3E=");

    const auto = [...host.querySelectorAll<HTMLButtonElement>(".dh-livebtn")].find((b) => b.textContent === "AUTO")!;
    auto.click();
    expect(auto.getAttribute("aria-pressed")).toBe("true");
    await vi.advanceTimersByTimeAsync(29_000);
    expect(positionCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(positionCalls()).toHaveLength(2);
    expect(positionCalls()[1]).toContain("&date%3E=");
    // The delta re-serves the fixture; the merged board still renders.
    expect(host.querySelector(".dh-split-R > .dh-tabbody")!.getAttribute("data-state")).toBe("ready");

    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(positionCalls()).toHaveLength(3);

    tab.unmount();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(positionCalls()).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
