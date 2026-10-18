/** A HubDeps for tab tests: real DOM helpers, a fixture-backed F1Api, no picker UI. Needs a DOM environment (happy-dom). */
import { createF1Api, type F1Api } from "../../../src/data/api";
import { clear, compoundLetter, el } from "../../../src/data/dom";
import type { HubDeps } from "../../../src/data/hub-deps";
import { LIST, type Rgb } from "../../../src/data/teams";
import { fixtureFetch, MemoryStorage } from "./fixtures";

export function stubDeps(routes: [string, string][], over: Partial<HubDeps> = {}): HubDeps & { api: F1Api } {
  const api = over.api ?? createF1Api({ fetch: fixtureFetch(routes), storage: new MemoryStorage() });
  const cssColor = (c: Rgb | null | undefined): string => (c ? `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})` : "rgb(128,128,128)");
  const findTeam = (n: string | null | undefined) => (n ? LIST.find((t) => n.toLowerCase().includes(t.name.toLowerCase().split(" ")[0]!.toLowerCase())) ?? null : null);
  const deps: HubDeps & { api: F1Api } = {
    api,
    el, clear,
    emptyMsg: (text) => el("div", "dh-empty", text),
    spinner: () => el("div", "dh-loading", "LOADING"),
    fmtDateTime: (iso) => iso ?? "—",
    sel: { year: 2026, meetingKey: 1295, sessionKey: 11377, meta: null, selAt: Date.now(), pinned: true },
    ensureSession: () => Promise.resolve(deps.sel.meta),
    buildPicker: () => el("div", "dh-picker"),
    invalidateOther: () => {},
    findTeam,
    cssColor,
    textColorOn: () => "#fff",
    teamChip: (code) => el("span", "dh-codechip", code || "—"),
    compoundChipLabel: (c) => compoundLetter(c) || "—",
    COMPOUND: { SOFT: "#e8002d", MEDIUM: "#f6d200", HARD: "#f0f0f0", INTERMEDIATE: "#3fb950", WET: "#1e90ff" },
    close: () => {},
    isOpen: () => true,
    motionReduced: () => true,
    NO_LIVE_MSG: "No live data", NO_TELEM_MSG: "No telemetry", NO_RESULT_MSG: "No classification",
    ...over,
  };
  return deps;
}
