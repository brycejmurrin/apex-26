// @vitest-environment happy-dom
/* Unscored launch comparisons. Assertions ported from f1-game
 * tests/unit/garage-followups.test.mjs:207-284 (measuredFixture and the
 * SetupTrials tests). */
import { describe, expect, it } from "vitest";
import { createSetupTrials, contextIssues, type TrialLaunchOptions, type TrialLaunchResult } from "../../../src/garage/setup-trials";
import { createSetupTune } from "../../../src/garage/setup-tune";
import { f1Load, hasF1Garage, plain, revStore } from "./f1-garage-vm";

type Launch = (o: TrialLaunchOptions) => Promise<TrialLaunchResult> | TrialLaunchResult;

function measuredFixture() {
  const { store } = revStore();
  const S = createSetupTune(store), T = createSetupTrials(S);
  const context = (): Record<string, unknown> => ({ unscored: true, stableWeather: true, physics: "rev1", car: "haas", parts: { engine: "a" }, track: "monza", point: 0, weather: { type: "dry", wet: 0 }, tyres: { id: "medium", wear: 0, temp: 85 }, fuel: 1, energy: 1, assists: { traction: false } });
  const baseline = S.get("haas"), candidate = { ...baseline, arbF: baseline.arbF + 1 };
  const begin = (launch: Launch = async () => ({ ok: true, context: context() })) => T.create({ teamId: "haas", store, baseline, candidate, launch });
  return { store, S, T, context, baseline, candidate, begin };
}
const buttons = (root: Element): HTMLButtonElement[] => Array.from(root.querySelectorAll("button"));
const click = (b: HTMLButtonElement | undefined): unknown => (b!.onclick as unknown as () => unknown)();

describe("SetupTrials (f1-game js/garage/setup-trials.js)", () => {
  it("measured launches require three clean baseline, A/A and candidate repeats; show median and spread only for equivalent starts", async () => {
    const h = measuredFixture(); h.begin();
    for (const arm of ["baseline", "control", "candidate"] as const) for (const score of [3, 3.2, 3.1]) {
      expect(await h.T.attempt(arm)).toBe(true); expect(h.T.record({ mode: "launch", clean: true, score }, h.context())).toBe(true);
    }
    const s = h.T.summary()!; expect(s.comparable).toBe(true); expect(s.delta).toBe(0); expect(s.groups.control.n).toBe(3); expect(Math.abs((s.groups.baseline.spread as number) - 0.2) < 1e-10).toBe(true);
    expect(h.T.record({ mode: "launch", clean: true, score: 1 }, h.context())).toBe(false);
    h.T.cancel();
  });

  it("each changed starting condition and missing conditions exclude receipts and suppress comparison", async () => {
    for (const key of ["physics", "car", "parts", "track", "point", "weather", "tyres", "fuel", "energy", "assists"]) {
      const h = measuredFixture(); let next = h.context(); h.begin(async () => ({ ok: true, context: next })); await h.T.attempt("baseline"); h.T.record({ mode: "launch", clean: true, score: 3 }, h.context());
      next = { ...h.context(), [key]: "changed" }; await h.T.attempt("candidate"); h.T.record({ mode: "launch", clean: true, score: 2 }, h.context());
      const s = h.T.summary()!; expect(s.receipts[1]!.valid, key).toBe(false); expect(s.receipts[1]!.issues.join(" ")).toMatch(new RegExp(key)); expect(s.delta).toBeNull(); h.T.cancel();
    }
    const h = measuredFixture(); h.begin(async () => ({ ok: true, context: {} })); await h.T.attempt("baseline"); h.T.record({ mode: "launch", clean: true, score: 1 }, {}); expect(h.T.summary()!.receipts[0]!.valid).toBe(false);
  });

  it("unclean attempts, mid-run weather/tune changes and retries are excluded", async () => {
    const h = measuredFixture(); h.begin(); await h.T.attempt("baseline"); h.T.record({ mode: "launch", clean: false, score: 3, reason: "contact" }, h.context());
    await h.T.attempt("candidate"); h.T.record({ mode: "launch", clean: true, score: 2 }, { ...h.context(), weather: "wet" });
    await h.T.attempt("baseline"); h.T.invalidate("rewind"); expect(h.T.summary()!.receipts.filter((r) => r.valid).length).toBe(0); expect(h.T.summary()!.receipts[2]!.issues.join(" ")).toMatch(/rewind/); h.T.cancel();
  });

  it("cancel restores only its owned mechanical sheet and pending launch receives a revocable lease", async () => {
    const h = measuredFixture(); h.begin(); await h.T.attempt("candidate"); h.T.cancel(); expect(h.S.get("haas")).toEqual(h.baseline);
    h.begin(); await h.T.attempt("candidate"); h.S.set("haas", { arbF: 11 }); h.T.cancel(); expect(h.S.get("haas").arbF).toBe(11);
    let finish: (r: TrialLaunchResult) => void = () => {}, lease: () => boolean = () => false;
    h.begin((o) => { lease = o.isCurrent; return new Promise<TrialLaunchResult>((r) => { finish = r; }); });
    const pending = h.T.attempt("candidate"); expect(lease()).toBe(true); h.T.cancel(); expect(lease()).toBe(false);
    finish({ ok: true, context: h.context() }); expect(await pending).toBe(false); expect(h.T.active()).toBe(false);
  });

  it("comparison controls are reachable in actual DOM and capture the candidate on explicit Begin", async () => {
    const h = measuredFixture(), host = document.createElement("div"); document.body.appendChild(host); let starts = 0;
    h.T.mount(host, { teamId: "haas", store: h.store, baseline: h.baseline, candidateNow: () => h.S.get("haas"), launch: async () => { starts++; return { ok: true, context: h.context() }; } });
    const bs = buttons(host); h.S.set("haas", { arbF: 10 }); click(bs.find((b) => b.textContent === "BEGIN COMPARISON"));
    await click(bs.find((b) => b.textContent === "RUN CANDIDATE")); await Promise.resolve();
    expect(starts).toBe(1); expect(h.S.get("haas").arbF).toBe(10); expect(h.T.summary()!.pending).toBe(true); h.T.cancel();
  });

  it("transient condition drift stays excluded even when restored before completion; same-value user writes release ownership", async () => {
    const h = measuredFixture(); h.begin(); await h.T.attempt("baseline"); h.T.observe({ ...h.context(), weather: "wet" }); h.T.observe(h.context()); h.T.record({ mode: "launch", clean: true, score: 3 }, h.context());
    expect(h.T.summary()!.receipts[0]!.issues.join(" ")).toMatch(/weather changed/);
    h.T.cancel(); h.begin(); await h.T.attempt("candidate"); h.S.set("haas", h.candidate); h.T.cancel(); expect(h.S.get("haas")).toEqual(h.candidate);
  });

  it("A/A control drift suppresses observed delta and attempt receipts are bounded", async () => {
    const h = measuredFixture(); h.begin();
    for (const arm of ["baseline", "control", "candidate"] as const) for (let i = 0; i < 3; i++) { await h.T.attempt(arm); h.T.record({ mode: "launch", clean: true, score: arm === "control" ? 5 : 3 }, h.context()); }
    expect(h.T.summary()!.comparable).toBe(false); expect(h.T.summary()!.delta).toBeNull();
    for (let i = 0; i < 3; i++) { await h.T.attempt("baseline"); h.T.record({ mode: "launch", clean: true, score: 3 }, h.context()); }
    expect(await h.T.attempt("baseline")).toBe(false); expect(h.T.summary()!.receipts.filter((x) => x.arm === "baseline").length).toBe(6); h.T.cancel();
  });

  it("pause comparison return preserves completed receipts, excludes incomplete run and safely stops before cancellation restore", async () => {
    const h = measuredFixture(), pause = document.createElement("div"), body = document.createElement("div"); body.className = "sheet-body"; pause.appendChild(body); document.body.appendChild(pause);
    const calls: [string, unknown][] = [];
    const G = { $: () => pause, quitToMenu: () => { calls.push(["quit", h.S.get("haas").arbF]); }, openGarageFrom: (from: string) => { calls.push(["garage", from]); } };
    const ui = h.T.mountPause(G)!; expect(h.T.mountPause(G)).toBe(ui); expect(ui.section.hidden).toBe(true);
    h.begin(); await h.T.attempt("baseline"); h.T.record({ mode: "launch", clean: true, score: 3 }, h.context()); await h.T.attempt("candidate");
    const bs = buttons(ui.section); click(bs.find((b) => b.textContent === "RETURN TO SETUP COMPARISON"));
    expect(h.T.active()).toBe(true); expect(h.T.summary()!.receipts.length).toBe(2); expect(h.T.summary()!.receipts[0]!.valid).toBe(true); expect(h.T.summary()!.receipts[1]!.valid).toBe(false); expect(calls.map((x) => x[0])).toEqual(["quit", "garage"]);
    click(bs.find((b) => b.textContent === "CANCEL SETUP COMPARISON")); expect(calls[2]![0]).toBe("quit"); expect(calls[2]![1]).toBe(h.candidate.arbF);
    expect(h.S.get("haas")).toEqual(h.baseline); expect(h.T.active()).toBe(false); expect(ui.section.hidden).toBe(true); ui.dispose();
  });

  it("explicit cancellation calls runtime cancellation while its async launch lease is still valid", async () => {
    const h = measuredFixture(); let lease: () => boolean = () => false, finish: (r: TrialLaunchResult) => void = () => {}, cancelled = false;
    h.T.create({ teamId: "haas", store: h.store, baseline: h.baseline, candidate: h.candidate, launch: (o) => { lease = o.isCurrent; return new Promise<TrialLaunchResult>((r) => { finish = r; }); }, cancelRuntime: () => { cancelled = lease(); } });
    const pending = h.T.attempt("candidate"); h.T.cancel(); expect(cancelled).toBe(true); expect(lease()).toBe(false); finish({ ok: true, context: h.context() }); expect(await pending).toBe(false);
  });

  it("pause comparison controls cannot quit a later ordinary session with no runtime ownership", async () => {
    const h = measuredFixture(), pause = document.createElement("div"), body = document.createElement("div"); body.className = "sheet-body"; pause.appendChild(body); document.body.appendChild(pause); let owns = true, quits = 0;
    const ui = h.T.mountPause({ $: () => pause, setupTrialContext: () => (owns ? h.context() : null), quitToMenu: () => { quits++; }, openGarageFrom() {} })!;
    h.begin(); await h.T.attempt("baseline"); expect(ui.section.hidden).toBe(false); owns = false; ui.refresh(); expect(ui.section.hidden).toBe(true);
    for (const b of buttons(ui.section)) click(b); expect(quits).toBe(0); h.T.cancel(); ui.dispose();
  });

  it("instances are independent: one comparison per instance", () => {
    const a = measuredFixture(), b = measuredFixture();
    a.begin(); expect(a.T.active()).toBe(true); expect(b.T.active()).toBe(false);
  });
});

describe.skipIf(!hasF1Garage)("contextIssues matches f1-game's setup-trials.js", () => {
  it("over present, missing, changed and unverified contexts", () => {
    const get = f1Load(["js/garage/setup-trials.js"], { SetupTune: {} });
    const vm = (get("SetupTrials") as { contextIssues(a: unknown, b: unknown, keys?: unknown): unknown }).contextIssues;
    const base = { unscored: true, stableWeather: true, physics: "r", car: "c", parts: { b: 1, a: 2 }, track: "t", point: 0, weather: "dry", tyres: { id: "m" }, fuel: 1, energy: 1, assists: {} };
    const cases: (Record<string, unknown> | null)[] = [null, {}, base, { ...base, unscored: false }, { ...base, stableWeather: "yes" }, { ...base, parts: { a: 2, b: 1 } }, { ...base, parts: { a: 3, b: 1 } }, { ...base, point: null }, { ...base, fuel: undefined }];
    for (const a of cases) for (const b of cases) {
      expect(contextIssues(a, b), JSON.stringify([a, b])).toEqual(plain(vm(a, b)));
      expect(contextIssues(a, b, ["physics", "weather"])).toEqual(plain(vm(a, b, ["physics", "weather"])));
    }
  });
});
