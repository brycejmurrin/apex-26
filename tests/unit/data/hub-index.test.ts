// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createF1Api } from "../../../src/data/api";
import { mountDataHub, type TabId } from "../../../src/data";
import { setDataLog } from "../../../src/data/log";
import { fixtureFetch, MemoryStorage } from "./fixtures";

const ROUTES: [string, string][] = [
  ["/ergast/f1/2026.json", "jolpica-2025-schedule.json"],
  ["/driverstandings.json", "jolpica-2025-driverstandings.json"],
  ["/constructorstandings.json", "jolpica-2025-constructorstandings.json"],
  ["/meetings?year=2026", "openf1-2026-meetings.json"],
  ["/sessions?meeting_key=1295", "openf1-1295-sessions.json"],
  ["/session_result?session_key=11377", "openf1-11377-session-result.json"],
  ["/drivers?session_key=11377", "openf1-11377-drivers.json"],
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
  setDataLog({ info: () => {}, warn: () => {} });
  document.body.innerHTML = "";
});
afterEach(() => { vi.useRealTimers(); });

describe("mountDataHub", () => {
  it("wires every tab, each paints something other than a spinner", async () => {
    const api = createF1Api({ fetch: fixtureFetch(ROUTES), storage: new MemoryStorage() });
    const root = document.createElement("dialog");
    root.hidden = true;
    document.body.appendChild(root);
    const hub = mountDataHub(root, { api });
    const ids: TabId[] = ["schedule", "standings", "results", "live", "telemetry", "race", "export"];
    expect([...root.querySelectorAll(".dh-tab")].map((b) => b.id)).toEqual(ids.map((i) => "dh-tab-" + i));
    for (const id of ids) {
      hub.open(id);
      await vi.advanceTimersByTimeAsync(5000);
      const panel = root.querySelector("#dh-panel")!;
      expect(panel.children.length, id).toBeGreaterThan(0);
      expect(panel.querySelector(":scope > .dh-loading"), id).toBe(null);
    }
    hub.close();
    expect(root.hidden).toBe(true);
  });
});
