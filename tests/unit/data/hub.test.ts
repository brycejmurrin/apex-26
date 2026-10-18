// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createF1Api } from "../../../src/data/api";
import { el } from "../../../src/data/dom";
import { apiYears, createDataHub, findTeam, meetingPickerOptions, textColorOn, type HubTabs } from "../../../src/data/hub";
import type { HubDeps, TabNode } from "../../../src/data/hub-deps";
import { setDataLog } from "../../../src/data/log";
import { fixtureFetch, MemoryStorage } from "./fixtures";

const ROUTES: [string, string][] = [
  ["/meetings?year=2026", "openf1-2026-meetings.json"],
  ["/sessions?meeting_key=1295", "openf1-1295-sessions.json"],
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
  setDataLog({ info: () => {}, warn: () => {} });
  document.body.innerHTML = "";
});
afterEach(() => { vi.useRealTimers(); });

function fakeTabs(loads: Partial<Record<string, () => Promise<TabNode>>> = {}) {
  const counts: Record<string, number> = {};
  const loader = (id: string) => () => {
    counts[id] = (counts[id] || 0) + 1;
    return (loads[id] ?? (() => Promise.resolve(el("div", "tab-" + id, id))))();
  };
  let picked: HubDeps | null = null;
  const tabs: HubTabs = {
    schedule: (d) => { picked = d; return { loadSchedule: loader("schedule") }; },
    standings: () => ({ loadStandings: loader("standings") }),
    results: () => ({ loadResults: loader("results") }),
    live: () => ({ loadLive: loader("live"), stopLiveAuto: () => {}, disarmLiveAuto: () => {} }),
    telemetry: () => ({ loadTelemetry: loader("telemetry"), closeTelemPopup: () => false }),
    export: () => ({ loadExport: loader("export") }),
  };
  return { tabs, counts, deps: () => picked as unknown as HubDeps };
}

function mountHub(tabs: HubTabs) {
  const api = createF1Api({ fetch: fixtureFetch(ROUTES), storage: new MemoryStorage() });
  const root = el("dialog");
  root.hidden = true;
  document.body.appendChild(root);
  const hub = createDataHub({ tabs, api });
  hub.init(root);
  return { hub, root, panel: () => root.querySelector("#dh-panel") as HTMLElement };
}

describe("data hub shell", () => {
  it("builds the tab strip with export under developer tools", () => {
    const { root } = mountHub(fakeTabs().tabs);
    const tabs = [...root.querySelectorAll(".dh-tabs .dh-tab")].map((b) => b.textContent);
    expect(tabs).toEqual(["SCHEDULE", "STANDINGS", "RESULTS", "LIVE", "TELEMETRY"]);
    expect(root.querySelector(".dh-developer-tools #dh-tab-export")).not.toBe(null);
  });

  it("loads a tab once and reuses it inside MAX_AGE", async () => {
    const f = fakeTabs();
    const { hub, root, panel } = mountHub(f.tabs);
    hub.open("standings");
    expect(root.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(panel().querySelector(".tab-standings")).not.toBe(null);
    expect(panel().querySelector(".dh-footnote")?.textContent).toBe("updated just now");
    (root.querySelector("#dh-tab-schedule") as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(0);
    (root.querySelector("#dh-tab-standings") as HTMLButtonElement).click();
    expect(f.counts.standings).toBe(1);
    vi.advanceTimersByTime(61 * 60 * 1000);
    (root.querySelector("#dh-tab-standings") as HTMLButtonElement).click();
    expect(f.counts.standings).toBe(2);
    hub.close();
    expect(root.hidden).toBe(true);
  });

  it("keeps the stale node under an error banner when a refresh fails", async () => {
    let fail = false;
    const f = fakeTabs({ schedule: () => (fail ? Promise.reject(new Error("HTTP 503")) : Promise.resolve(el("div", "tab-schedule"))) });
    const { hub, root, panel } = mountHub(f.tabs);
    hub.open("schedule");
    await vi.advanceTimersByTimeAsync(0);
    fail = true;
    vi.advanceTimersByTime(7 * 60 * 60 * 1000);
    (root.querySelector("#dh-tab-schedule") as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(panel().querySelector(".dh-error")?.getAttribute("data-reason")).toBe("upstream-cached");
    expect(panel().querySelector(".tab-schedule")).not.toBe(null);
    expect(panel().querySelector(".dh-retry")).not.toBe(null);
  });

  it("picker defaults to the latest started meeting and its race", async () => {
    const f = fakeTabs();
    const { hub } = mountHub(f.tabs);
    const deps = f.deps();
    deps.sel.year = 2026;
    hub.open("results");
    const picks: unknown[] = [];
    const box = deps.buildPicker((m) => picks.push(m));
    document.body.appendChild(box);
    await vi.runAllTimersAsync();
    const [gp, ses] = [...box.querySelectorAll("select")];
    expect(deps.sel.meetingKey).toBe(1296);   // Singapore started 2026-10-09; Austin later
    expect(gp!.title).toMatch(/Singapore/);
    expect(ses!.textContent).toBe("no data");   // no Singapore sessions fixture: OpenF1 404 → empty
  });
});

describe("hub helpers", () => {
  it("matches API team names by sponsor-free keys", () => {
    expect(findTeam("Red Bull Racing")?.short).toBe("RBR");
    expect(findTeam("Racing Bulls")?.short).toBe("RB");
    expect(findTeam("Kick Sauber")?.short).toBe("AUD");
    expect(findTeam("Nobody")).toBe(null);
    expect(textColorOn([1, 1, 1])).toBe("#0a0a0f");
  });
  it("disambiguates duplicate meeting names", () => {
    const opts = meetingPickerOptions([
      { meetingKey: 1, name: "Pre-Season Testing", circuit: "Sakhir", country: null, dateStart: "2026-02-11T07:00:00", cancelled: false },
      { meetingKey: 2, name: "Pre-Season Testing", circuit: "Sakhir", country: null, dateStart: "2026-02-18T07:00:00", cancelled: false },
      { meetingKey: 3, name: "Italian Grand Prix", circuit: "Monza", country: null, dateStart: null, cancelled: false },
    ]);
    expect(opts.map((o) => o.label)).toEqual([
      "Pre-Season Testing · Sakhir · 2026-02-11", "Pre-Season Testing · Sakhir · 2026-02-18", "Italian Grand Prix · Monza"]);
    expect(apiYears()).toEqual([2026, 2025, 2024, 2023]);
  });
});
